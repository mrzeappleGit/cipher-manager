//! Always-listening wake-word assistant ("Cipher"). A dedicated thread feeds
//! 16 kHz mic frames to Porcupine (loaded at runtime from
//! ~/.claude/cipher-manager/porcupine/); on wake it captures the spoken
//! command until trailing silence and hands the wav to the frontend, which
//! transcribes, routes, and answers. Engine missing → clean error, app fine.

use serde::Serialize;
use std::ffi::{c_char, c_void, CString};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Mutex};
use tauri::Emitter;

const SAMPLE_RATE: u32 = 16_000;
const FRAME_LEN: usize = 512; // Porcupine's fixed frame length
const CMD_MAX_SECS: f64 = 10.0;
const CMD_TAIL_SILENCE_SECS: f64 = 1.2;
const LOUD_F32: f32 = 0.02; // same silence floor as the meeting recorder

static STOP: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
// 0 off · 1 listening · 2 capturing a command
static PHASE: AtomicU8 = AtomicU8::new(0);
static LAST_ERR: Mutex<String> = Mutex::new(String::new());

fn engine_dir() -> Result<PathBuf, String> {
    let root = crate::claude::claude_root().ok_or("No ~/.claude directory")?;
    Ok(root.join("cipher-manager").join("porcupine"))
}

// --- Minimal FFI over libpv_porcupine.dll (official Picovoice C API) -------

struct Engine {
    _lib: libloading::Library, // keep loaded; fns borrow from it
    handle: *mut c_void,
    process: unsafe extern "C" fn(*mut c_void, *const i16, *mut i32) -> i32,
    delete: unsafe extern "C" fn(*mut c_void),
}
unsafe impl Send for Engine {}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { (self.delete)(self.handle) };
    }
}

fn init_engine(access_key: &str, keyword_path: &str) -> Result<Engine, String> {
    let dir = engine_dir()?;
    let dll = dir.join("libpv_porcupine.dll");
    let model = dir.join("porcupine_params.pv");
    if !dll.is_file() || !model.is_file() {
        return Err(format!(
            "Porcupine engine not installed — expected libpv_porcupine.dll and porcupine_params.pv in {}",
            dir.display()
        ));
    }
    // No custom .ppn yet → built-in "Computer" so the feature works day one.
    let keyword_path = if keyword_path.trim().is_empty() {
        dir.join("computer_windows.ppn").to_string_lossy().to_string()
    } else {
        keyword_path.to_string()
    };
    let keyword_path = keyword_path.as_str();
    if !std::path::Path::new(keyword_path).is_file() {
        return Err(format!("Wake keyword file not found: {keyword_path}"));
    }
    unsafe {
        let lib = libloading::Library::new(&dll).map_err(|e| e.to_string())?;
        type InitFn = unsafe extern "C" fn(
            *const c_char, // access_key
            *const c_char, // model_path
            i32,           // num_keywords
            *const *const c_char,
            *const f32,
            *mut *mut c_void,
        ) -> i32;
        let init: libloading::Symbol<InitFn> =
            lib.get(b"pv_porcupine_init").map_err(|e| e.to_string())?;
        let process = *lib
            .get::<unsafe extern "C" fn(*mut c_void, *const i16, *mut i32) -> i32>(b"pv_porcupine_process")
            .map_err(|e| e.to_string())?;
        let delete = *lib
            .get::<unsafe extern "C" fn(*mut c_void)>(b"pv_porcupine_delete")
            .map_err(|e| e.to_string())?;

        let key = CString::new(access_key).map_err(|e| e.to_string())?;
        let model_c = CString::new(model.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let kw = CString::new(keyword_path).map_err(|e| e.to_string())?;
        let kw_ptrs = [kw.as_ptr()];
        let sens = [0.6f32];
        let mut handle: *mut c_void = std::ptr::null_mut();
        let status = init(key.as_ptr(), model_c.as_ptr(), 1, kw_ptrs.as_ptr(), sens.as_ptr(), &mut handle);
        if status != 0 || handle.is_null() {
            return Err(format!(
                "Porcupine init failed (status {status}) — check the AccessKey and that the .ppn is a Windows keyword file"
            ));
        }
        Ok(Engine { _lib: lib, handle, process, delete })
    }
}

// --- Mic → 16 kHz mono frames ----------------------------------------------

/// Streaming linear resampler: push native-rate mono f32, pull 16 kHz samples.
struct Resampler {
    ratio: f64,
    pos: f64,
    buf: Vec<f32>,
}

impl Resampler {
    fn new(in_rate: u32) -> Self {
        Self { ratio: in_rate as f64 / SAMPLE_RATE as f64, pos: 0.0, buf: Vec::new() }
    }
    fn push(&mut self, samples: &[f32], out: &mut Vec<i16>) {
        self.buf.extend_from_slice(samples);
        while (self.pos as usize) + 1 < self.buf.len() {
            let j = self.pos as usize;
            let frac = (self.pos - j as f64) as f32;
            let s = self.buf[j] + (self.buf[j + 1] - self.buf[j]) * frac;
            out.push((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            self.pos += self.ratio;
        }
        let consumed = self.pos as usize;
        if consumed > 0 {
            self.buf.drain(..consumed.min(self.buf.len()));
            self.pos -= consumed as f64;
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCommand {
    pub path: String,
    pub seconds: f64,
}

fn run_loop(app: tauri::AppHandle, engine: Engine, rx: mpsc::Receiver<Vec<f32>>, in_rate: u32) {
    let mut rs = Resampler::new(in_rate);
    let mut pcm: Vec<i16> = Vec::new();
    let mut frame = [0i16; FRAME_LEN];
    let loud_i16 = (LOUD_F32 * i16::MAX as f32) as i16;

    // capturing state
    let mut capture: Vec<i16> = Vec::new();
    let mut silent_run = 0usize; // consecutive silent samples while capturing
    let mut heard = false; // any speech since capture started
    let tail = (CMD_TAIL_SILENCE_SECS * SAMPLE_RATE as f64) as usize;
    let max_len = (CMD_MAX_SECS * SAMPLE_RATE as f64) as usize;
    // Nothing said 3s into a capture (stray wake / declined follow-up) →
    // cancel quietly instead of shipping 10s of silence to the STT.
    let no_speech = 3 * SAMPLE_RATE as usize;

    while !STOP.load(Ordering::Relaxed) {
        let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(300)) else { continue };
        rs.push(&chunk, &mut pcm);

        while pcm.len() >= FRAME_LEN {
            frame.copy_from_slice(&pcm[..FRAME_LEN]);
            pcm.drain(..FRAME_LEN);

            if PHASE.load(Ordering::Relaxed) == 2 {
                // Capturing the command: accumulate + watch for trailing silence.
                capture.extend_from_slice(&frame);
                let loud = frame.iter().any(|s| s.unsigned_abs() > loud_i16 as u16);
                heard |= loud;
                silent_run = if loud { 0 } else { silent_run + FRAME_LEN };
                if !heard && capture.len() >= no_speech {
                    capture.clear();
                    silent_run = 0;
                    PHASE.store(1, Ordering::Relaxed);
                    let _ = app.emit("voice-cancel", ());
                    continue;
                }
                let done = capture.len() >= max_len
                    || (silent_run >= tail && capture.len() > silent_run + SAMPLE_RATE as usize / 2);
                if done {
                    let secs = capture.len() as f64 / SAMPLE_RATE as f64;
                    match write_command_wav(&capture) {
                        Ok(p) => {
                            let _ = app.emit("voice-command", VoiceCommand { path: p, seconds: secs });
                        }
                        Err(e) => *LAST_ERR.lock().unwrap() = e,
                    }
                    capture.clear();
                    silent_run = 0;
                    heard = false;
                    PHASE.store(1, Ordering::Relaxed);
                }
            } else {
                let mut idx: i32 = -1;
                let status = unsafe { (engine.process)(engine.handle, frame.as_ptr(), &mut idx) };
                if status == 0 && idx >= 0 {
                    PHASE.store(2, Ordering::Relaxed);
                    capture.clear();
                    silent_run = 0;
                    heard = false;
                    let _ = app.emit("voice-wake", ());
                }
            }
        }
    }
    PHASE.store(0, Ordering::Relaxed);
    RUNNING.store(false, Ordering::Relaxed);
}

fn write_command_wav(samples: &[i16]) -> Result<String, String> {
    let root = crate::claude::claude_root().ok_or("No ~/.claude directory")?;
    let dir = root.join("cipher-manager").join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("voice-{}.wav", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wr = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
    for s in samples {
        wr.write_sample(*s).map_err(|e| e.to_string())?;
    }
    wr.finalize().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// --- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn start_voice(app: tauri::AppHandle, access_key: String, keyword_path: String) -> Result<(), String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // already listening
    }
    STOP.store(false, Ordering::SeqCst);
    let access_key = crate::secrets::resolve_secrets(&access_key);
    let engine = match init_engine(&access_key, &keyword_path) {
        Ok(e) => e,
        Err(e) => {
            RUNNING.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let (tx, rx) = mpsc::channel::<Vec<f32>>();
        let host = cpal::default_host();
        let Some(dev) = host.default_input_device() else {
            *LAST_ERR.lock().unwrap() = "No microphone found".into();
            RUNNING.store(false, Ordering::SeqCst);
            return;
        };
        let Ok(cfg) = dev.default_input_config() else {
            *LAST_ERR.lock().unwrap() = "No usable mic config".into();
            RUNNING.store(false, Ordering::SeqCst);
            return;
        };
        let in_rate = cfg.sample_rate().0;
        let channels = cfg.channels() as usize;
        let tx2 = tx.clone();
        // Mix to mono in the callback; resampling happens on our thread.
        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => dev.build_input_stream(
                &cfg.into(),
                move |data: &[f32], _: &_| {
                    let mono: Vec<f32> =
                        data.chunks(channels).map(|c| c.iter().sum::<f32>() / channels as f32).collect();
                    let _ = tx2.send(mono);
                },
                |_| {},
                None,
            ),
            cpal::SampleFormat::I16 => dev.build_input_stream(
                &cfg.into(),
                move |data: &[i16], _: &_| {
                    let mono: Vec<f32> = data
                        .chunks(channels)
                        .map(|c| c.iter().map(|s| *s as f32 / i16::MAX as f32).sum::<f32>() / channels as f32)
                        .collect();
                    let _ = tx2.send(mono);
                },
                |_| {},
                None,
            ),
            f => {
                *LAST_ERR.lock().unwrap() = format!("unsupported mic format {f}");
                RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        };
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                *LAST_ERR.lock().unwrap() = e.to_string();
                RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        };
        if let Err(e) = stream.play() {
            *LAST_ERR.lock().unwrap() = e.to_string();
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
        PHASE.store(1, Ordering::Relaxed);
        run_loop(app, engine, rx, in_rate); // returns when STOP is set
        drop(stream);
    });
    Ok(())
}

#[tauri::command]
pub fn stop_voice() {
    STOP.store(true, Ordering::SeqCst);
}

/// Skip the wake word and capture a command right now — the push-to-talk path
/// (global hotkey, which a Stream Deck "Hotkey" action can send).
pub fn trigger_capture(app: &tauri::AppHandle) -> Result<(), String> {
    if !RUNNING.load(Ordering::Relaxed) {
        return Err("Voice assistant isn't running — enable it in Settings.".into());
    }
    // listening → capturing; already-capturing or off states are left alone.
    if PHASE
        .compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let _ = app.emit("voice-wake", ());
    }
    Ok(())
}

#[tauri::command]
pub fn trigger_voice(app: tauri::AppHandle) -> Result<(), String> {
    trigger_capture(&app)
}

pub const PTT_SHORTCUT: &str = "ctrl+alt+c";

/// Does this global-shortcut event belong to push-to-talk? Mirrors
/// `shot::is_shot_shortcut` — the pattern that lets the shared handler in
/// lib.rs dispatch explicitly instead of falling through to voice by default.
pub fn is_ptt_shortcut(s: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    PTT_SHORTCUT
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|k| &k == s)
        .unwrap_or(false)
}

/// Follow the settings toggle: (un)register the global push-to-talk hotkey.
#[tauri::command]
pub fn set_ptt_hotkey(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let registered = gs.is_registered(PTT_SHORTCUT);
    if enabled && !registered {
        gs.register(PTT_SHORTCUT).map_err(|e| e.to_string())
    } else if !enabled && registered {
        gs.unregister(PTT_SHORTCUT).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub running: bool,
    pub phase: u8,
    pub last_error: String,
}

#[tauri::command]
pub fn voice_status() -> VoiceStatus {
    VoiceStatus {
        running: RUNNING.load(Ordering::Relaxed),
        phase: PHASE.load(Ordering::Relaxed),
        last_error: LAST_ERR.lock().unwrap().clone(),
    }
}

/// Loopback-only trigger server (127.0.0.1:4671) for the Stream Deck plugin:
/// POST/GET /trigger starts push-to-talk, GET /status feeds the key icon.
/// Same trust level as the global hotkey — local machine only, no secrets.
pub fn start_trigger_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:4671") {
            Ok(s) => s,
            Err(e) => {
                *LAST_ERR.lock().unwrap() = format!("trigger server: {e}");
                return;
            }
        };
        for req in server.incoming_requests() {
            let url = req.url().to_string();
            let json = |body: String| {
                tiny_http::Response::from_string(body).with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                )
            };
            let resp = if url.starts_with("/trigger") {
                match trigger_capture(&app) {
                    Ok(()) => json("{\"ok\":true}".into()),
                    Err(e) => json(format!("{{\"ok\":false,\"error\":{}}}", serde_json::json!(e)))
                        .with_status_code(409),
                }
            } else if url.starts_with("/status") {
                json(format!(
                    "{{\"running\":{},\"phase\":{}}}",
                    RUNNING.load(Ordering::Relaxed),
                    PHASE.load(Ordering::Relaxed)
                ))
            } else {
                tiny_http::Response::from_string("not found").with_status_code(404)
            };
            let _ = req.respond(resp);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_halves_48k() {
        let mut rs = Resampler::new(48_000);
        let mut out = Vec::new();
        rs.push(&vec![0.5f32; 48_000], &mut out);
        // 1s of 48k in → ~1s of 16k out (±1 sample at the boundary)
        assert!((out.len() as i64 - 16_000).abs() <= 2, "got {}", out.len());
        assert!(out.iter().all(|s| (*s - (0.5 * i16::MAX as f32) as i16).abs() <= 2));
    }

    #[test]
    fn ptt_shortcut_is_parseable() {
        // A typo here would silently drop push-to-talk out of the dispatch —
        // with the old catch-all `else` gone, an unparseable constant means
        // Ctrl+Alt+C matches nothing at all instead of falling back to voice.
        let k: tauri_plugin_global_shortcut::Shortcut =
            PTT_SHORTCUT.parse().expect("PTT_SHORTCUT must parse");
        assert!(is_ptt_shortcut(&k));
    }
}
