//! Meeting recorder — captures the microphone AND system output (WASAPI
//! loopback, so Teams/Zoom participants are recorded without virtual-cable
//! tricks), mixes both to a 16 kHz mono WAV, and transcribes it in chunks
//! through the same STT providers the mic button already uses.
//!
//! cpal `Stream`s are !Send, so all stream handles live on one dedicated
//! thread; commands talk to it through atomics + a join handle.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

const MIX_RATE: u32 = 16_000; // Whisper's preferred rate; keeps files small.

struct Rec {
    stop: Arc<AtomicBool>,
    started: Instant,
    final_path: PathBuf,
    /// Per-source 16 kHz tracks kept beside the mix — the mic track is always
    /// "me", so two-track transcription labels the local speaker perfectly.
    mic_path: PathBuf,
    sys_path: PathBuf,
    sources: String,
    /// Epoch millis of the last sample above the loudness floor — lets the
    /// auto-recorder stop on silence instead of guessing when a meeting ended.
    active: Arc<AtomicU64>,
    handle: std::thread::JoinHandle<Result<(), String>>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Amplitude floor (~ -34 dBFS) below which audio counts as silence.
const LOUD_F32: f32 = 0.02;
const LOUD_I16: i16 = (LOUD_F32 * i16::MAX as f32) as i16;

static REC: Mutex<Option<Rec>> = Mutex::new(None);

pub(crate) fn recordings_dir() -> Result<PathBuf, String> {
    let root = crate::claude::claude_root().ok_or("No ~/.claude directory")?;
    let dir = root.join("cipher-manager").join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// One capture source writing 16-bit PCM to a temp WAV at its native config.
struct Capture {
    path: PathBuf,
    writer: Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>>>,
    stream: cpal::Stream,
}

fn start_capture(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    path: PathBuf,
    active: Arc<AtomicU64>,
) -> Result<Capture, String> {
    let spec = hound::WavSpec {
        channels: config.channels(),
        sample_rate: config.sample_rate().0,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let writer = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(Some(writer)));
    let w = writer.clone();
    let err_fn = |e| eprintln!("recorder stream error: {e}");

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.config(),
            move |data: &[f32], _: &_| {
                let mut loud = false;
                if let Some(wr) = w.lock().unwrap().as_mut() {
                    for &s in data {
                        loud |= s.abs() > LOUD_F32;
                        let _ = wr.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                    }
                }
                if loud {
                    active.store(now_millis(), Ordering::Relaxed);
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.config(),
            move |data: &[i16], _: &_| {
                let mut loud = false;
                if let Some(wr) = w.lock().unwrap().as_mut() {
                    for &s in data {
                        loud |= s.unsigned_abs() > LOUD_I16 as u16;
                        let _ = wr.write_sample(s);
                    }
                }
                if loud {
                    active.store(now_millis(), Ordering::Relaxed);
                }
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.config(),
            move |data: &[u16], _: &_| {
                let mut loud = false;
                if let Some(wr) = w.lock().unwrap().as_mut() {
                    for &s in data {
                        let c = (s as i32 - 32768) as i16;
                        loud |= c.unsigned_abs() > LOUD_I16 as u16;
                        let _ = wr.write_sample(c);
                    }
                }
                if loud {
                    active.store(now_millis(), Ordering::Relaxed);
                }
            },
            err_fn,
            None,
        ),
        f => return Err(format!("unsupported sample format {f}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(Capture { path, writer, stream })
}

/// Read a temp WAV back as mono f32 resampled to MIX_RATE (linear — plenty for speech).
fn load_mono_16k(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let ch = spec.channels as usize;
    let mut mono: Vec<f32> = Vec::new();
    {
        let mut acc = 0f32;
        let mut n = 0usize;
        for s in reader.samples::<i16>() {
            acc += s.map_err(|e| e.to_string())? as f32 / i16::MAX as f32;
            n += 1;
            if n == ch {
                mono.push(acc / ch as f32);
                acc = 0.0;
                n = 0;
            }
        }
    }
    if spec.sample_rate == MIX_RATE {
        return Ok(mono);
    }
    let ratio = spec.sample_rate as f64 / MIX_RATE as f64;
    let out_len = (mono.len() as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let j = pos as usize;
        let frac = (pos - j as f64) as f32;
        let a = mono.get(j).copied().unwrap_or(0.0);
        let b = mono.get(j + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    Ok(out)
}

fn write_mono16k(path: &Path, samples: impl Iterator<Item = f32>) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: MIX_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wr = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for s in samples {
        wr.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .map_err(|e| e.to_string())?;
    }
    wr.finalize().map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub recording: bool,
    pub seconds: f64,
    pub sources: String,
    /// Seconds since the last audible sample — 0 while someone is talking.
    pub silence_secs: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub path: String,
    pub name: String,
    pub seconds: f64,
    pub modified: Option<String>,
    pub mic_path: Option<String>,
    pub sys_path: Option<String>,
    /// screen-<epoch>.mp4 whose start falls inside this recording's window,
    /// so the rescue path can re-run visual analysis too.
    pub screen_path: Option<String>,
}

/// Match a screen capture (start-epoch seconds + path) to a recording window.
fn screen_for_window(screens: &[(i64, String)], start: i64, end: i64) -> Option<String> {
    screens
        .iter()
        .find(|(t, _)| *t >= start - 5 && *t <= end + 5)
        .map(|(_, p)| p.clone())
}

/// Finished recordings on disk (mixed finals only — per-source tracks and
/// in-flight temps are implementation detail). Newest first. Lets the UI show
/// recordings whose transcribe→note pipeline failed (docker down, STT error).
pub fn list_recordings_impl() -> Result<Vec<RecordingFile>, String> {
    let dir = recordings_dir()?;
    let mut out = Vec::new();
    let mut screens: Vec<(i64, String)> = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(epoch) = name
            .strip_prefix("screen-")
            .and_then(|s| s.strip_suffix(".mp4"))
            .and_then(|s| s.parse::<i64>().ok())
        {
            screens.push((epoch, e.path().to_string_lossy().to_string()));
        }
    }
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !lower.ends_with(".wav")
            || lower.starts_with("tmp-")
            || lower.starts_with("voice-") // wake-word command clips, not meetings
            || lower.ends_with("-mic.wav")
            || lower.ends_with("-sys.wav")
        {
            continue;
        }
        let seconds = hound::WavReader::open(&p)
            .map(|r| r.duration() as f64 / r.spec().sample_rate.max(1) as f64)
            .unwrap_or(0.0);
        let modified_t = e.metadata().ok().and_then(|m| m.modified().ok());
        let modified =
            modified_t.map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339());
        // mtime is the recording END; the window for screen matching runs back
        // from there by the audio duration.
        let screen_path = modified_t
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| {
                let end = d.as_secs() as i64;
                screen_for_window(&screens, end - seconds as i64, end)
            });
        let sib = |suffix: &str| {
            let s = p.with_file_name(format!("{}-{suffix}.wav", name.trim_end_matches(".wav")));
            s.is_file().then(|| s.to_string_lossy().to_string())
        };
        let (mic_path, sys_path) = (sib("mic"), sib("sys"));
        out.push(RecordingFile {
            path: p.to_string_lossy().to_string(),
            name,
            seconds,
            modified,
            mic_path,
            sys_path,
            screen_path,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn list_recordings() -> Result<Vec<RecordingFile>, String> {
    list_recordings_impl()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingDone {
    pub path: String,
    /// 16 kHz mono mic-only / system-only tracks (when that source recorded).
    pub mic_path: Option<String>,
    pub sys_path: Option<String>,
    pub seconds: f64,
    pub sources: String,
}

/// Start capturing mic + system audio. Returns a note describing which
/// sources are live ("mic + system", "mic only", …).
#[tauri::command]
pub fn start_recording() -> Result<String, String> {
    let mut guard = REC.lock().unwrap();
    if guard.is_some() {
        return Err("Already recording".into());
    }
    let dir = recordings_dir()?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let final_path = dir.join(format!("meeting-{stamp}.wav"));
    let mic_path = dir.join(format!("meeting-{stamp}-mic.wav"));
    let sys_path = dir.join(format!("meeting-{stamp}-sys.wav"));
    let mic_tmp = dir.join(format!("tmp-{stamp}-mic.wav"));
    let sys_tmp = dir.join(format!("tmp-{stamp}-sys.wav"));

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let active = Arc::new(AtomicU64::new(now_millis()));
    let active2 = active.clone();
    let fp = final_path.clone();
    let mic_out = mic_path.clone();
    let sys_out = sys_path.clone();
    let (tx, rx) = mpsc::channel::<Result<String, String>>();

    let handle = std::thread::spawn(move || -> Result<(), String> {
        let host = cpal::default_host();
        let mut caps: Vec<(Capture, &'static str)> = Vec::new();
        let mut sources: Vec<&str> = Vec::new();

        if let Some(dev) = host.default_input_device() {
            if let Ok(cfg) = dev.default_input_config() {
                if let Ok(c) = start_capture(&dev, &cfg, mic_tmp.clone(), active2.clone()) {
                    caps.push((c, "mic"));
                    sources.push("mic");
                }
            }
        }
        // System audio: WASAPI opens an *output* device as an input stream in
        // loopback mode — this is what captures Teams/Zoom without a cable.
        if let Some(dev) = host.default_output_device() {
            if let Ok(cfg) = dev.default_output_config() {
                if let Ok(c) = start_capture(&dev, &cfg, sys_tmp.clone(), active2.clone()) {
                    caps.push((c, "sys"));
                    sources.push("system");
                }
            }
        }
        if caps.is_empty() {
            let _ = tx.send(Err("No audio devices available".into()));
            return Err("no devices".into());
        }
        let note = sources.join(" + ");
        let _ = tx.send(Ok(note));

        while !stop2.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(120));
        }

        // Finalize raw captures, keep a 16 kHz mono file per source (mic is
        // always the local speaker — powers exact "Me" labels), then mix.
        let mut monos: Vec<Vec<f32>> = Vec::new();
        for (c, kind) in caps.drain(..) {
            drop(c.stream); // stop callbacks before finalizing the writer
            if let Some(wr) = c.writer.lock().unwrap().take() {
                let _ = wr.finalize();
            }
            let mono = load_mono_16k(&c.path)?;
            let _ = std::fs::remove_file(&c.path);
            write_mono16k(if kind == "mic" { &mic_out } else { &sys_out }, mono.iter().copied())?;
            monos.push(mono);
        }
        let len = monos.iter().map(|t| t.len()).max().unwrap_or(0);
        write_mono16k(
            &fp,
            (0..len).map(|i| monos.iter().map(|t| t.get(i).copied().unwrap_or(0.0)).sum()),
        )
    });

    let sources = rx
        .recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| "Recorder thread didn't start".to_string())??;

    *guard = Some(Rec {
        stop,
        started: Instant::now(),
        final_path,
        mic_path,
        sys_path,
        sources: sources.clone(),
        active,
        handle,
    });
    Ok(sources)
}

#[tauri::command]
pub fn recording_status() -> RecordingStatus {
    let guard = REC.lock().unwrap();
    match guard.as_ref() {
        Some(r) => RecordingStatus {
            recording: true,
            seconds: r.started.elapsed().as_secs_f64(),
            sources: r.sources.clone(),
            silence_secs: (now_millis().saturating_sub(r.active.load(Ordering::Relaxed))) as f64
                / 1000.0,
        },
        None => RecordingStatus {
            recording: false,
            seconds: 0.0,
            sources: String::new(),
            silence_secs: 0.0,
        },
    }
}

/// Stop, mix, and return the final WAV path. Blocking (the mix of a long
/// recording takes a few seconds).
pub fn stop_recording_impl() -> Result<RecordingDone, String> {
    let rec = REC.lock().unwrap().take().ok_or("Not recording")?;
    rec.stop.store(true, Ordering::Relaxed);
    let seconds = rec.started.elapsed().as_secs_f64();
    rec.handle.join().map_err(|_| "Recorder thread panicked".to_string())??;
    let track = |p: &PathBuf| p.is_file().then(|| p.display().to_string());
    Ok(RecordingDone {
        path: rec.final_path.display().to_string(),
        mic_path: track(&rec.mic_path),
        sys_path: track(&rec.sys_path),
        seconds,
        sources: rec.sources,
    })
}

#[tauri::command]
pub async fn stop_recording() -> Result<RecordingDone, String> {
    tauri::async_runtime::spawn_blocking(stop_recording_impl).await.map_err(|e| e.to_string())?
}

/// Rebuild a "**Speaker N:** …" transcript from a diarized ElevenLabs Scribe
/// response (`words[]` with `speaker_id`). None when the response isn't diarized.
fn labeled_transcript(v: &serde_json::Value) -> Option<String> {
    let words = v.get("words")?.as_array()?;
    if !words.iter().any(|w| w.get("speaker_id").and_then(|s| s.as_str()).is_some()) {
        return None;
    }
    let mut out = String::new();
    let mut cur = String::new();
    for w in words {
        let txt = w.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let kind = w.get("type").and_then(|t| t.as_str()).unwrap_or("word");
        let sp = w.get("speaker_id").and_then(|s| s.as_str()).unwrap_or("");
        if kind != "spacing" && !sp.is_empty() && sp != cur {
            let label = sp
                .strip_prefix("speaker_")
                .and_then(|n| n.parse::<u32>().ok())
                .map(|n| format!("Speaker {}", n + 1))
                .unwrap_or_else(|| sp.to_string());
            while out.ends_with(' ') {
                out.pop(); // drop inter-speaker spacing
            }
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(&format!("**{label}:** "));
            cur = sp.to_string();
        } else if out.is_empty() {
            continue; // leading spacing before the first word
        }
        out.push_str(txt);
    }
    Some(out)
}

/// Transcribe a recorded WAV via the same hand-built multipart POST stt_proxy
/// uses, split into `chunk_secs` pieces (10 min default for Whisper's upload
/// limit; ElevenLabs takes the whole file so diarized speaker labels stay
/// consistent). The path is confined to the recordings dir.
pub fn transcribe_recording_impl(
    path: &str,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    fields: &std::collections::HashMap<String, String>,
    chunk_secs: Option<u64>,
) -> Result<String, String> {
    let dir = recordings_dir()?.canonicalize().map_err(|e| e.to_string())?;
    let p = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !p.starts_with(&dir) {
        return Err("Path is outside the recordings folder".into());
    }
    if !crate::commands::proxy_allowed(url) {
        return Err("This URL isn't allowed (use https://, or http:// only on localhost).".into());
    }

    let mut reader = hound::WavReader::open(&p).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let samples: Vec<i16> = reader
        .samples::<i16>()
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let secs = chunk_secs.unwrap_or(600).max(30) as usize;
    let chunk_len = (spec.sample_rate as usize) * (spec.channels as usize) * secs;
    let mut out: Vec<String> = Vec::new();

    for chunk in samples.chunks(chunk_len.max(1)) {
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        {
            let mut wr = hound::WavWriter::new(&mut buf, spec).map_err(|e| e.to_string())?;
            for &s in chunk {
                wr.write_sample(s).map_err(|e| e.to_string())?;
            }
            wr.finalize().map_err(|e| e.to_string())?;
        }
        let (status, body) = crate::commands::multipart_post(
            url,
            headers,
            fields,
            "file",
            "audio.wav",
            "audio/wav",
            &buf.into_inner(),
            600,
        )?;
        if status >= 300 {
            return Err(format!("Transcription failed ({status}): {}", &body[..body.len().min(200)]));
        }
        let v: Option<serde_json::Value> = serde_json::from_str(&body).ok();
        let text = v
            .as_ref()
            .and_then(labeled_transcript)
            .or_else(|| {
                v.as_ref()
                    .and_then(|x| x.get("text").and_then(|t| t.as_str()).map(String::from))
            })
            .unwrap_or_default();
        if !text.trim().is_empty() {
            out.push(text.trim().to_string());
        }
    }
    Ok(out.join("\n\n"))
}

#[tauri::command]
pub async fn transcribe_recording(
    path: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    fields: std::collections::HashMap<String, String>,
    chunk_secs: Option<u64>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcribe_recording_impl(&path, &url, &headers, &fields, chunk_secs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Timestamped utterances from a Scribe response: (start_sec, label, text).
/// `forced` overrides speaker labels (mic track → "Me"); otherwise diarized
/// speaker_ids become "Speaker N". Utterances split on speaker change or a
/// >2s gap so two tracks can interleave cleanly.
fn segments(v: &serde_json::Value, forced: Option<&str>) -> Vec<(f64, String, String)> {
    // WhisperX-style responses carry ready-made segments with SPEAKER_NN tags.
    if let Some(segs) = v.get("segments").and_then(|s| s.as_array()) {
        let mut out = Vec::new();
        for s in segs {
            let text = s.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
            if text.is_empty() {
                continue;
            }
            let start = s.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let label = forced.map(String::from).unwrap_or_else(|| {
                s.get("speaker")
                    .and_then(|x| x.as_str())
                    .map(|sp| {
                        sp.strip_prefix("SPEAKER_")
                            .and_then(|n| n.parse::<u32>().ok())
                            .map(|n| format!("Speaker {}", n + 1))
                            .unwrap_or_else(|| sp.to_string())
                    })
                    .unwrap_or_else(|| "Speaker 1".to_string())
            });
            out.push((start, label, text));
        }
        return out;
    }
    let Some(words) = v.get("words").and_then(|w| w.as_array()) else {
        let t = v.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
        return if t.is_empty() {
            vec![]
        } else {
            vec![(0.0, forced.unwrap_or("Speaker 1").to_string(), t)]
        };
    };
    let label_of = |w: &serde_json::Value| -> String {
        if let Some(f) = forced {
            return f.to_string();
        }
        w.get("speaker_id")
            .and_then(|s| s.as_str())
            .map(|sp| {
                sp.strip_prefix("speaker_")
                    .and_then(|n| n.parse::<u32>().ok())
                    .map(|n| format!("Speaker {}", n + 1))
                    .unwrap_or_else(|| sp.to_string())
            })
            .unwrap_or_else(|| "Speaker 1".to_string())
    };

    let mut out: Vec<(f64, String, String)> = Vec::new();
    let (mut cur_label, mut cur_start, mut cur_text) = (String::new(), 0.0f64, String::new());
    let mut last_end = 0.0f64;
    for w in words {
        let txt = w.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let kind = w.get("type").and_then(|t| t.as_str()).unwrap_or("word");
        let start = w.get("start").and_then(|s| s.as_f64()).unwrap_or(last_end);
        let end = w.get("end").and_then(|s| s.as_f64()).unwrap_or(start);
        if kind == "spacing" {
            if !cur_text.is_empty() {
                cur_text.push_str(txt);
            }
            continue;
        }
        let label = label_of(w);
        if cur_text.is_empty() {
            cur_label = label;
            cur_start = start;
        } else if label != cur_label || start - last_end > 2.0 {
            out.push((cur_start, cur_label.clone(), cur_text.trim().to_string()));
            cur_text.clear();
            cur_label = label;
            cur_start = start;
        }
        cur_text.push_str(txt);
        last_end = end;
    }
    if !cur_text.trim().is_empty() {
        out.push((cur_start, cur_label, cur_text.trim().to_string()));
    }
    out
}

/// True when the WAV has at least one sample above the silence floor.
/// Unreadable files pass through — the STT service gives the real error.
fn has_audio(p: &Path) -> bool {
    let Ok(mut r) = hound::WavReader::open(p) else { return true };
    r.samples::<i16>()
        .flatten()
        .any(|s| s.unsigned_abs() > LOUD_I16 as u16)
}

fn confined_recording(path: &str) -> Result<PathBuf, String> {
    let dir = recordings_dir()?.canonicalize().map_err(|e| e.to_string())?;
    let p = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !p.starts_with(&dir) {
        return Err("Path is outside the recordings folder".into());
    }
    Ok(p)
}

/// Two-track meeting transcription: the mic track is always the local speaker
/// ("Me" — no guessing), the system track carries everyone else (diarized).
/// Each track uploads whole (ElevenLabs handles hours-long files); segments
/// interleave by timestamp into one labelled transcript.
pub fn transcribe_meeting_impl(
    mic_path: Option<&str>,
    sys_path: Option<&str>,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    fields: &std::collections::HashMap<String, String>,
    file_field: Option<&str>,
    visuals: &[(f64, String)],
    speaker_hints: &[(f64, String)],
) -> Result<String, String> {
    if !crate::commands::proxy_allowed(url) {
        return Err("This URL isn't allowed (use https://, or http:// only on localhost).".into());
    }
    let file_field = file_field.unwrap_or("file");
    let mut segs: Vec<(f64, String, String)> = Vec::new();
    for (path, forced) in [(mic_path, Some("Me")), (sys_path, None)] {
        let Some(path) = path else { continue };
        let p = confined_recording(path)?;
        // A dead track (muted mic) 500s WhisperX's diarizer — skip it and
        // transcribe what actually has speech.
        if !has_audio(&p) {
            continue;
        }
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        let (status, body) = crate::commands::multipart_post(
            url, headers, fields, file_field, "audio.wav", "audio/wav", &bytes, 1800,
        )?;
        if status >= 300 {
            return Err(format!("Transcription failed ({status}): {}", &body[..body.len().min(200)]));
        }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        segs.extend(segments(&v, forced));
    }
    if segs.is_empty() {
        return Err("No audible speech found in the recording.".into());
    }
    segs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    apply_speaker_hints(&mut segs, speaker_hints);
    Ok(merge_segments(segs, visuals))
}

/// Reserved label marking a pre-formatted visual paragraph (never merges).
const VISUAL: &str = "\u{0}visual";

fn mmss(t: f64) -> String {
    let s = t.max(0.0) as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Auto-generated diarization label ("Speaker 1", "Speaker 12", …)?
fn is_generic_speaker(label: &str) -> bool {
    label
        .strip_prefix("Speaker ")
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Rename generic `Speaker N` labels using timestamped active-speaker
/// observations from the screen recording. Attribution: each hint belongs to
/// the segment whose [start, next-start) window contains it. A label takes
/// its majority name at ≥2 observations; ties don't rename; a name can only
/// be claimed once (strictly most observations wins — an equal-count
/// collision renames nobody), and a name already used by a non-generic label
/// in `segs` (e.g. "Me") is never claimed. `segs` must be sorted by time.
fn apply_speaker_hints(segs: &mut [(f64, String, String)], hints: &[(f64, String)]) {
    use std::collections::{HashMap, HashSet};
    // label -> name -> count
    let mut votes: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for (t, name) in hints {
        // Last segment whose start is <= t (segments are sorted).
        let Some(seg) = segs.iter().take_while(|s| s.0 <= *t).last() else { continue };
        if is_generic_speaker(&seg.1) {
            *votes.entry(seg.1.clone()).or_default().entry(name.clone()).or_default() += 1;
        }
    }
    // Per label: majority name with >=2 votes and no tie.
    let mut wants: Vec<(String, String, usize)> = vec![]; // (label, name, count)
    for (label, names) in votes {
        let mut best: Vec<(&String, &usize)> = names.iter().collect();
        best.sort_by(|a, b| b.1.cmp(a.1));
        match best.as_slice() {
            [(name, &n), rest @ ..] if n >= 2 && rest.first().map_or(true, |(_, &m)| m < n) => {
                wants.push((label, (*name).clone(), n));
            }
            _ => {}
        }
    }
    // A name can only be claimed once: the strictly strongest claim wins;
    // equal-count claims cancel out (mirrors the intra-label tie rule, and
    // keeps the outcome independent of HashMap iteration order). Names
    // already present as a non-generic label (e.g. "Me") are off-limits so a
    // rename can never merge someone else's speech into an existing identity.
    let taken: HashSet<&str> = segs
        .iter()
        .map(|s| s.1.as_str())
        .filter(|l| !is_generic_speaker(l))
        .collect();
    let mut by_name: HashMap<String, Vec<(String, usize)>> = HashMap::new();
    for (label, name, n) in wants {
        by_name.entry(name).or_default().push((label, n));
    }
    let mut renames: HashMap<String, String> = HashMap::new();
    for (name, mut claims) in by_name {
        if taken.contains(name.as_str()) {
            continue;
        }
        claims.sort_by(|a, b| b.1.cmp(&a.1));
        if claims.len() == 1 || claims[0].1 > claims[1].1 {
            renames.insert(claims.swap_remove(0).0, name);
        }
    }
    for s in segs.iter_mut() {
        if let Some(new) = renames.get(&s.1) {
            s.1 = new.clone();
        }
    }
}

/// Interleave transcript segments with screen-capture notes and render the
/// final markdown transcript. Consecutive same-speaker utterances merge into
/// one paragraph; visual notes never merge and always break paragraphs.
fn merge_segments(mut segs: Vec<(f64, String, String)>, visuals: &[(f64, String)]) -> String {
    for (t, text) in visuals {
        segs.push((*t, VISUAL.to_string(), format!("**[{}] On screen:** {}", mmss(*t), text)));
    }
    segs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = String::new();
    let mut last_label = String::new();
    for (_, label, text) in segs {
        if label == last_label && label != VISUAL {
            out.push(' ');
            out.push_str(&text);
        } else {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            if label == VISUAL {
                out.push_str(&text); // already fully formatted
            } else {
                out.push_str(&format!("**{label}:** {text}"));
            }
            last_label = label;
        }
    }
    out
}

#[tauri::command]
pub async fn transcribe_meeting(
    mic_path: Option<String>,
    sys_path: Option<String>,
    url: String,
    headers: std::collections::HashMap<String, String>,
    fields: std::collections::HashMap<String, String>,
    file_field: Option<String>,
    visuals: Option<Vec<(f64, String)>>,
    speaker_hints: Option<Vec<(f64, String)>>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcribe_meeting_impl(
            mic_path.as_deref(),
            sys_path.as_deref(),
            &url,
            &headers,
            &fields,
            file_field.as_deref(),
            visuals.as_deref().unwrap_or(&[]),
            speaker_hints.as_deref().unwrap_or(&[]),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- Local WhisperX docker lifecycle ---------------------------------------
// The GPU box shouldn't keep a 26 GB ASR container warm all day; the app
// starts it for a transcription and stops it after (manual buttons too).

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStatus {
    /// False when the docker daemon itself is down — callers must not read
    /// `exists` as "container missing" in that case; a "start" boots Docker.
    pub daemon_up: bool,
    pub exists: bool,
    pub running: bool,
}

/// True when the docker daemon answers.
fn docker_daemon_up() -> bool {
    let mut c = std::process::Command::new("docker");
    c.args(["info", "--format", "{{.ServerVersion}}"]);
    crate::commands::no_window(&mut c);
    matches!(c.output(), Ok(o) if o.status.success())
}

/// Boot Docker Desktop when the daemon is down and wait for it to answer.
/// Only called on explicit "start" actions — passive status polls must never
/// launch Docker on a gaming PC that keeps it off on purpose.
fn ensure_docker_daemon() -> Result<(), String> {
    if docker_daemon_up() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let exe = std::path::PathBuf::from(
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into()),
        )
        .join("Docker")
        .join("Docker")
        .join("Docker Desktop.exe");
        if exe.is_file() {
            let mut c = std::process::Command::new(exe);
            crate::commands::no_window(&mut c);
            c.spawn().map_err(|e| format!("couldn't launch Docker Desktop: {e}"))?;
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while std::time::Instant::now() < deadline {
        if docker_daemon_up() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    Err("Docker daemon didn't come up in 2 minutes — is Docker Desktop installed?".into())
}

pub fn docker_container_impl(name: &str, action: &str) -> Result<ContainerStatus, String> {
    let ok_name = !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok_name {
        return Err("bad container name".into());
    }
    if action == "start" {
        ensure_docker_daemon()?;
    }
    if matches!(action, "start" | "stop") {
        let mut c = std::process::Command::new("docker");
        c.args([action, name]);
        crate::commands::no_window(&mut c);
        let out = c.output().map_err(|e| format!("docker not available: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    } else if action != "status" {
        return Err("bad action".into());
    }
    let mut c = std::process::Command::new("docker");
    c.args(["inspect", "--format", "{{.State.Running}}", name]);
    crate::commands::no_window(&mut c);
    match c.output() {
        Ok(out) if out.status.success() => Ok(ContainerStatus {
            daemon_up: true,
            exists: true,
            running: String::from_utf8_lossy(&out.stdout).trim() == "true",
        }),
        // inspect fails both when the container is missing AND when the daemon
        // is down; conflating them made "status" report a phantom missing
        // container that blocked the very "start" that would boot Docker.
        Ok(_) => Ok(ContainerStatus {
            daemon_up: docker_daemon_up(),
            exists: false,
            running: false,
        }),
        Err(e) => Err(format!("docker not available: {e}")),
    }
}

#[tauri::command]
pub async fn docker_container(name: String, action: String) -> Result<ContainerStatus, String> {
    tauri::async_runtime::spawn_blocking(move || docker_container_impl(&name, &action))
        .await
        .map_err(|e| e.to_string())?
}

/// Import an arbitrary audio/video file: ffmpeg converts it to a 16 kHz mono
/// WAV inside the recordings dir so the normal transcription flow (and its
/// path confinement) applies. Returns the same shape as stop_recording.
pub fn import_recording_impl(src: &str) -> Result<RecordingDone, String> {
    let src_path = Path::new(src);
    if !src_path.is_file() {
        return Err(format!("File not found: {src}"));
    }
    let dir = recordings_dir()?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let out = dir.join(format!("import-{stamp}.wav"));
    let status = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(src_path)
        .args(["-ac", "1", "-ar", "16000"])
        .arg(&out)
        .status()
        .map_err(|e| format!("ffmpeg not available: {e}"))?;
    if !status.success() || !out.is_file() {
        return Err("ffmpeg couldn't read that file (is it audio/video?)".into());
    }
    let reader = hound::WavReader::open(&out).map_err(|e| e.to_string())?;
    let seconds = reader.duration() as f64 / reader.spec().sample_rate as f64;
    Ok(RecordingDone {
        path: out.display().to_string(),
        mic_path: None,
        sys_path: None,
        seconds,
        sources: "imported".into(),
    })
}

/// Native open-file dialog for picking an audio/video file. None = cancelled.
#[tauri::command]
pub async fn pick_audio_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(rfd::FileDialog::new()
            .set_title("Pick a recording to transcribe")
            .add_filter(
                "Audio / video",
                &["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "webm", "mp4", "mkv", "mov"],
            )
            .pick_file()
            .map(|p| p.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_recording(src: String) -> Result<RecordingDone, String> {
    tauri::async_runtime::spawn_blocking(move || import_recording_impl(&src))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live probe against the real docker CLI: "status" must report the
    /// daemon's actual state, never a phantom missing container when the
    /// daemon is down. `cargo test -- --ignored real_docker_status`
    #[test]
    #[ignore = "shells out to the real docker CLI"]
    fn real_docker_status_reports_daemon_state() {
        let st = docker_container_impl("cipher-no-such-container-probe", "status")
            .expect("status failed");
        assert_eq!(st.daemon_up, docker_daemon_up());
        assert!(!st.exists);
        assert!(!st.running);
    }

    /// Full boot chain: "start" with Docker Desktop off must boot the daemon
    /// and start the container (the rescue-path fix for daemon-down = phantom
    /// "not found"). Stops the container after; leaves Docker Desktop up.
    /// `cargo test -- --ignored --nocapture real_docker_boot`
    #[test]
    #[ignore = "boots real Docker Desktop and starts the WhisperX container"]
    fn real_docker_boot_and_start() {
        let name = "whisperx-whisperx-1";
        let st = docker_container_impl(name, "start").expect("start failed");
        assert!(st.daemon_up && st.exists && st.running, "container not running after start");
        docker_container_impl(name, "stop").expect("stop failed");
    }

    /// Live probe over the real recordings dir: any recording with a screen
    /// capture inside its window must surface it (e.g. the 2026-07-23 Teams
    /// meeting + screen-1784827854.mp4 on this machine).
    /// `cargo test -- --ignored --nocapture real_list_recordings`
    #[test]
    #[ignore = "reads the real recordings dir on this machine"]
    fn real_list_recordings_screen_match() {
        let recs = list_recordings_impl().expect("list failed");
        assert!(!recs.is_empty());
        for r in &recs {
            println!("{} {:?}", r.name, r.screen_path);
        }
        assert!(
            recs.iter().any(|r| r.screen_path.is_some()),
            "no recording matched a screen capture — expected at least the 2026-07-23 one"
        );
    }

    #[test]
    fn screen_matches_recording_window_only() {
        let screens = vec![
            (1_000_100, "a.mp4".to_string()), // inside [1_000_000, 1_000_540]
            (2_000_000, "b.mp4".to_string()), // some other meeting
        ];
        assert_eq!(
            screen_for_window(&screens, 1_000_000, 1_000_540).as_deref(),
            Some("a.mp4")
        );
        // picker dwell: capture started seconds before mtime-derived start
        assert_eq!(
            screen_for_window(&screens, 1_000_103, 1_000_540).as_deref(),
            Some("a.mp4")
        );
        assert_eq!(screen_for_window(&screens, 3_000_000, 3_000_600), None);
    }

    #[test]
    fn silent_wavs_are_detected() {
        let dir = std::env::temp_dir();
        let write = |name: &str, sample: i16| {
            let p = dir.join(name);
            write_mono16k(&p, (0..16000).map(move |_| sample as f32 / i16::MAX as f32)).unwrap();
            p
        };
        let silent = write("cm-test-silent.wav", 0);
        let loud = write("cm-test-loud.wav", i16::MAX / 2);
        assert!(!has_audio(&silent));
        assert!(has_audio(&loud));
        let _ = std::fs::remove_file(silent);
        let _ = std::fs::remove_file(loud);
    }

    #[test]
    fn segments_split_and_force_labels() {
        let v: serde_json::Value = serde_json::json!({
            "words": [
                {"text": "hello", "type": "word", "start": 0.0, "end": 0.4, "speaker_id": "speaker_0"},
                {"text": " ", "type": "spacing"},
                {"text": "there", "type": "word", "start": 0.5, "end": 0.9, "speaker_id": "speaker_0"},
                {"text": "late", "type": "word", "start": 5.0, "end": 5.4, "speaker_id": "speaker_0"}
            ]
        });
        // Gap >2s splits an utterance; forced label overrides speaker ids.
        let s = segments(&v, Some("Me"));
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], (0.0, "Me".into(), "hello there".into()));
        assert_eq!(s[1].2, "late");
        // Diarized labels come through when not forced.
        assert_eq!(segments(&v, None)[0].1, "Speaker 1");
    }

    #[test]
    fn diarized_transcript_labels_speakers() {
        let v: serde_json::Value = serde_json::json!({
            "text": "hi there hello",
            "words": [
                {"text": "hi", "type": "word", "speaker_id": "speaker_0"},
                {"text": " ", "type": "spacing"},
                {"text": "there", "type": "word", "speaker_id": "speaker_0"},
                {"text": " ", "type": "spacing"},
                {"text": "hello", "type": "word", "speaker_id": "speaker_1"}
            ]
        });
        assert_eq!(
            labeled_transcript(&v).unwrap(),
            "**Speaker 1:** hi there\n\n**Speaker 2:** hello"
        );
        // Non-diarized responses fall through to plain text.
        let plain: serde_json::Value = serde_json::json!({ "text": "just text" });
        assert!(labeled_transcript(&plain).is_none());
    }

    #[test]
    fn merge_weaves_visuals_by_time_without_merging_them() {
        let segs = vec![
            (0.0, "Me".to_string(), "hello".to_string()),
            (10.0, "Me".to_string(), "still me".to_string()),
            (40.0, "Speaker 1".to_string(), "hi".to_string()),
        ];
        let visuals = vec![(5.0, "Title slide".to_string()), (35.0, "Roadmap".to_string())];
        let out = merge_segments(segs, &visuals);
        let expect = "**Me:** hello\n\n\
**[0:05] On screen:** Title slide\n\n\
**Me:** still me\n\n\
**[0:35] On screen:** Roadmap\n\n\
**Speaker 1:** hi";
        assert_eq!(out, expect);
        // No visuals → same-speaker merging still works.
        let segs2 = vec![
            (0.0, "Me".to_string(), "a".to_string()),
            (5.0, "Me".to_string(), "b".to_string()),
        ];
        assert_eq!(merge_segments(segs2, &[]), "**Me:** a b");
    }

    fn seg(t: f64, label: &str, text: &str) -> (f64, String, String) {
        (t, label.to_string(), text.to_string())
    }

    #[test]
    fn speaker_hints_rename_by_majority_vote() {
        // Speaker 1 talks 0-30 and 60-90; Speaker 2 talks 30-60; Me talks 90+.
        let mut segs = vec![
            seg(0.0, "Speaker 1", "a"),
            seg(30.0, "Speaker 2", "b"),
            seg(60.0, "Speaker 1", "c"),
            seg(90.0, "Me", "d"),
        ];
        let hints = vec![
            (5.0, "Alice".to_string()),
            (65.0, "Alice".to_string()),   // 2 votes Alice for Speaker 1
            (40.0, "Bob".to_string()),     // only 1 vote for Speaker 2 → below threshold
            (95.0, "Carol".to_string()),   // lands on "Me" → never renamed
        ];
        apply_speaker_hints(&mut segs, &hints);
        assert_eq!(segs[0].1, "Alice");
        assert_eq!(segs[2].1, "Alice");
        assert_eq!(segs[1].1, "Speaker 2"); // 1 observation < 2
        assert_eq!(segs[3].1, "Me");
    }

    #[test]
    fn speaker_hints_ties_collisions_and_foreign_labels() {
        // Tie inside one label → no rename.
        let mut tie = vec![seg(0.0, "Speaker 1", "a"), seg(60.0, "Speaker 1", "b")];
        apply_speaker_hints(
            &mut tie,
            &[(5.0, "Alice".into()), (10.0, "Alice".into()), (65.0, "Bob".into()), (70.0, "Bob".into())],
        );
        assert_eq!(tie[0].1, "Speaker 1");

        // Name collision across labels → more observations wins, loser keeps its label.
        let mut col = vec![seg(0.0, "Speaker 1", "a"), seg(60.0, "Speaker 2", "b")];
        apply_speaker_hints(
            &mut col,
            &[
                (5.0, "Alice".into()), (10.0, "Alice".into()), (15.0, "Alice".into()),
                (65.0, "Alice".into()), (70.0, "Alice".into()),
            ],
        );
        assert_eq!(col[0].1, "Alice");      // 3 observations
        assert_eq!(col[1].1, "Speaker 2");  // 2 observations, name taken

        // Equal-count collision on the same name → neither label renames.
        let mut eq = vec![seg(0.0, "Speaker 1", "a"), seg(60.0, "Speaker 2", "b")];
        apply_speaker_hints(
            &mut eq,
            &[(5.0, "Alice".into()), (10.0, "Alice".into()), (65.0, "Alice".into()), (70.0, "Alice".into())],
        );
        assert_eq!(eq[0].1, "Speaker 1");
        assert_eq!(eq[1].1, "Speaker 2");

        // Already-named labels are not eligible.
        let mut named = vec![seg(0.0, "Jane", "a"), seg(30.0, "Jane", "b")];
        apply_speaker_hints(&mut named, &[(5.0, "Bob".into()), (35.0, "Bob".into())]);
        assert_eq!(named[0].1, "Jane");

        // Empty hints → untouched.
        let mut plain = vec![seg(0.0, "Speaker 1", "a")];
        apply_speaker_hints(&mut plain, &[]);
        assert_eq!(plain[0].1, "Speaker 1");

        // A name matching an existing label ("Me") is never claimed.
        let mut me = vec![seg(0.0, "Speaker 1", "a"), seg(30.0, "Me", "b")];
        apply_speaker_hints(&mut me, &[(5.0, "Me".into()), (10.0, "Me".into())]);
        assert_eq!(me[0].1, "Speaker 1");

        // Hints before the first segment attribute to nothing → no rename.
        let mut early = vec![seg(1.0, "Speaker 1", "a")];
        apply_speaker_hints(&mut early, &[(0.1, "Alice".into()), (0.5, "Alice".into())]);
        assert_eq!(early[0].1, "Speaker 1");
    }

    /// Smoke test against the real audio devices on this machine: records ~2s
    /// of mic + system audio, mixes, and checks the final 16 kHz mono WAV.
    /// Ignored by default (needs hardware): cargo test -- --ignored real_record
    #[test]
    #[ignore]
    fn real_record() {
        let sources = start_recording().expect("start");
        println!("recording sources: {sources}");
        std::thread::sleep(std::time::Duration::from_secs(2));
        let done = stop_recording_impl().expect("stop");
        println!("wrote {} ({}s) mic={:?} sys={:?}", done.path, done.seconds, done.mic_path, done.sys_path);
        let reader = hound::WavReader::open(&done.path).expect("open wav");
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, MIX_RATE);
        assert!(reader.duration() > MIX_RATE, "should hold >1s of audio");
        // Per-source 16k tracks were kept for two-track transcription.
        for t in [&done.mic_path, &done.sys_path].into_iter().flatten() {
            let r = hound::WavReader::open(t).expect("open track");
            assert_eq!(r.spec().sample_rate, MIX_RATE);
            let _ = std::fs::remove_file(t);
        }
        // Confinement: transcribe refuses paths outside the recordings dir.
        let err = transcribe_recording_impl(
            "C:/Windows/win.ini",
            "https://example.com",
            &Default::default(),
            &Default::default(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("outside") || err.to_lowercase().contains("recordings"), "{err}");
        let _ = std::fs::remove_file(&done.path);
    }
}
