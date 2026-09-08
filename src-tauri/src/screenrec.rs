//! Meeting screen recording — capture a chosen window to mp4 via ffmpeg
//! gdigrab while the audio recorder runs, then (screenrec_analysis, Task 3)
//! describe screen changes with the Highlights Ollama model.
//! Desktop-only: no serve.rs arms.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::commands;

#[derive(Serialize, Clone, Debug)]
pub struct CaptureWindow {
    pub app: String,
    pub title: String,
    /// base64 JPEG preview (~240px wide); None when the window couldn't be
    /// rendered (minimized, zero-sized, PrintWindow refused).
    pub thumb: Option<String>,
}

/// Parse `Get-Process | ConvertTo-Json` output. PowerShell collapses a
/// single result to a bare object — accept both. Anything unparsable → [].
fn parse_window_list(json: &str) -> Vec<CaptureWindow> {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let items: Vec<&serde_json::Value> = match &v {
        serde_json::Value::Array(a) => a.iter().collect(),
        o => vec![o],
    };
    items
        .into_iter()
        .filter_map(|it| {
            let app = it.get("ProcessName")?.as_str()?.to_string();
            let title = it.get("MainWindowTitle")?.as_str()?.trim().to_string();
            let thumb = it
                .get("Thumb")
                .and_then(|t| t.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            if title.is_empty() { None } else { Some(CaptureWindow { app, title, thumb }) }
        })
        .collect()
}

/// Listing + per-window thumbnail via PrintWindow(PW_RENDERFULLCONTENT), which
/// renders real window content even when the window is behind others (our own
/// window is in front when the picker opens). First line forces UTF-8 stdout:
/// the default OEM codepage best-fit-maps some Unicode title chars (e.g. "●")
/// to raw control bytes, which breaks the JSON. `-InputObject` keeps a single
/// window serialized as an array (pipeline ConvertTo-Json would collapse it).
const LIST_WINDOWS_PS: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct CmRect { public int Left, Top, Right, Bottom; }
public class CmWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out CmRect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
}
'@
$rows = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
  $thumb = $null
  try {
    $h = $_.MainWindowHandle
    if (-not [CmWin]::IsIconic($h)) {
      $r = New-Object CmRect
      if ([CmWin]::GetWindowRect($h, [ref]$r)) {
        $w = $r.Right - $r.Left
        $ht = $r.Bottom - $r.Top
        if ($w -gt 0 -and $ht -gt 0) {
          $bmp = New-Object System.Drawing.Bitmap($w, $ht)
          $g = [System.Drawing.Graphics]::FromImage($bmp)
          $hdc = $g.GetHdc()
          $ok = [CmWin]::PrintWindow($h, $hdc, 2)
          $g.ReleaseHdc($hdc)
          $g.Dispose()
          if ($ok) {
            $tw = 240
            $th = [Math]::Max(1, [int]($ht * $tw / $w))
            $small = New-Object System.Drawing.Bitmap($bmp, $tw, $th)
            $ms = New-Object System.IO.MemoryStream
            $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
            $thumb = [Convert]::ToBase64String($ms.ToArray())
            $small.Dispose()
            $ms.Dispose()
          }
          $bmp.Dispose()
        }
      }
    }
  } catch {}
  [pscustomobject]@{ ProcessName = $_.ProcessName; MainWindowTitle = $_.MainWindowTitle; Thumb = $thumb }
})
ConvertTo-Json -InputObject $rows -Compress
"#;

fn list_capture_windows_impl() -> Result<Vec<CaptureWindow>, String> {
    // The C# DllImport lines need double quotes, which don't survive
    // -Command quoting through CreateProcess — run from a temp .ps1 instead.
    let script = std::env::temp_dir().join("cipher-manager-list-windows.ps1");
    std::fs::write(&script, LIST_WINDOWS_PS)
        .map_err(|e| format!("couldn't write window-list script: {e}"))?;
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script);
    commands::no_window(&mut c);
    let out = c.output().map_err(|e| format!("couldn't list windows: {e}"))?;
    Ok(parse_window_list(&String::from_utf8_lossy(&out.stdout)))
}

#[tauri::command]
pub async fn list_capture_windows() -> Result<Vec<CaptureWindow>, String> {
    tauri::async_runtime::spawn_blocking(list_capture_windows_impl)
        .await
        .map_err(|e| e.to_string())?
}

struct ScreenRec {
    child: Child,
    frames_dir: PathBuf,
    path: PathBuf,
}

static SCREEN: Mutex<Option<ScreenRec>> = Mutex::new(None);

/// Frame capture loop: one PrintWindow(PW_RENDERFULLCONTENT) JPEG per second.
/// gdigrab window capture BitBlts the window's GDI surface, which is black for
/// GPU-composited apps (Teams/WebView2, Chrome) — PrintWindow asks the app to
/// render its real content, and keeps working when the window is occluded.
/// Window lookup runs BEFORE the slow Add-Type so a bad title exits within the
/// Rust fail-fast check. Frames save to .tmp then rename, so a kill mid-write
/// never leaves a truncated JPEG for the encoder to choke on. Minimized or
/// failed ticks re-save the last good frame to keep index == elapsed seconds;
/// the loop schedules against absolute start time so it doesn't drift.
const CAPTURE_WINDOW_PS: &str = r#"
param([string]$Title, [string]$Frames)
$p = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if (-not $p) { exit 1 }
$h = $p.MainWindowHandle
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct CrRect { public int Left, Top, Right, Bottom; }
public class CrWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out CrRect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
}
'@
$start = Get-Date
$tick = 0
$i = 0
$lastOk = $null
while ([CrWin]::IsWindow($h)) {
  $out = Join-Path $Frames ('f-{0:D6}.jpg' -f $i)
  $done = $false
  try {
    if (-not [CrWin]::IsIconic($h)) {
      $r = New-Object CrRect
      if ([CrWin]::GetWindowRect($h, [ref]$r)) {
        $w = $r.Right - $r.Left
        $ht = $r.Bottom - $r.Top
        if ($w -gt 0 -and $ht -gt 0) {
          $bmp = New-Object System.Drawing.Bitmap($w, $ht)
          $g = [System.Drawing.Graphics]::FromImage($bmp)
          $hdc = $g.GetHdc()
          $ok = [CrWin]::PrintWindow($h, $hdc, 2)
          $g.ReleaseHdc($hdc)
          $g.Dispose()
          if ($ok) {
            $tmp = "$out.tmp"
            $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Jpeg)
            Move-Item -Force $tmp $out
            $done = $true
          }
          $bmp.Dispose()
        }
      }
    }
  } catch {}
  if (-not $done -and $lastOk) { Copy-Item $lastOk $out; $done = $true }
  if ($done) { $lastOk = $out; $i++ }
  $tick++
  $ms = (($start.AddSeconds($tick)) - (Get-Date)).TotalMilliseconds
  if ($ms -gt 0) { Start-Sleep -Milliseconds ([int]$ms) }
}
"#;

fn start_screen_record_impl(title: String) -> Result<String, String> {
    let mut guard = SCREEN.lock().map_err(|_| "screen recorder poisoned")?;
    if guard.is_some() {
        return Err("A screen recording is already running.".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let rec_dir = crate::recorder::recordings_dir()?;
    let path = rec_dir.join(format!("screen-{stamp}.mp4"));
    let frames_dir = rec_dir.join(format!("screen-{stamp}-frames"));
    std::fs::create_dir_all(&frames_dir).map_err(|e| format!("couldn't make frames dir: {e}"))?;
    let script = std::env::temp_dir().join("cipher-manager-capture-window.ps1");
    std::fs::write(&script, CAPTURE_WINDOW_PS)
        .map_err(|e| format!("couldn't write capture script: {e}"))?;
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg(&title)
        .arg(&frames_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    commands::no_window(&mut c);
    let mut child = c.spawn().map_err(|e| format!("couldn't start capture: {e}"))?;
    // Fail fast on a bad title — the script exits 1 before its Add-Type.
    std::thread::sleep(std::time::Duration::from_millis(800));
    if let Ok(Some(status)) = child.try_wait() {
        let _ = std::fs::remove_dir_all(&frames_dir);
        return Err(format!("screen capture didn't start (capture exited {status}) — window \"{title}\" not found?"));
    }
    let out = path.to_string_lossy().to_string();
    *guard = Some(ScreenRec { child, frames_dir, path });
    Ok(out)
}

#[tauri::command]
pub async fn start_screen_record(title: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || start_screen_record_impl(title))
        .await
        .map_err(|e| e.to_string())?
}

fn kill_capture(mut rec: ScreenRec) -> (PathBuf, PathBuf) {
    let _ = rec.child.kill();
    let _ = rec.child.wait();
    (rec.frames_dir, rec.path)
}

/// Assemble the 1fps frame sequence into the final mp4. Crop makes odd window
/// dimensions even (libx264 rejects them). Frame index == elapsed seconds, so
/// pts_time in later analysis maps straight to wall time.
fn assemble_frames(frames_dir: &PathBuf, path: &PathBuf) -> Result<(), String> {
    let pattern = frames_dir.join("f-%06d.jpg");
    let mut c = Command::new("ffmpeg");
    c.args(["-y", "-framerate", "1", "-start_number", "0", "-i"])
        .arg(&pattern)
        .args([
            "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    commands::no_window(&mut c);
    let status = c.status().map_err(|e| format!("couldn't run ffmpeg: {e}"))?;
    if !status.success() {
        return Err(format!("frame assembly failed ({status})"));
    }
    Ok(())
}

fn stop_screen_record_impl() -> Result<Option<String>, String> {
    let rec = {
        let mut guard = SCREEN.lock().map_err(|_| "screen recorder poisoned")?;
        guard.take()
    };
    let Some(rec) = rec else { return Ok(None) };
    let (frames_dir, path) = kill_capture(rec);
    let got_frames = frames_dir.join("f-000000.jpg").exists();
    if !got_frames || assemble_frames(&frames_dir, &path).is_err() {
        // ponytail: no frames or a broken assemble degrades to audio-only
        // instead of failing the whole stop; frames dir is kept for diagnosis.
        if !got_frames {
            let _ = std::fs::remove_dir_all(&frames_dir);
        }
        return Ok(None);
    }
    let _ = std::fs::remove_dir_all(&frames_dir);
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn stop_screen_record() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(stop_screen_record_impl)
        .await
        .map_err(|e| e.to_string())?
}

/// Best-effort cleanup on app exit: kill the capture loop so it doesn't keep
/// snapshotting after the app closes. No assembly here — exit must be fast;
/// the frames dir is left on disk for manual salvage.
pub(crate) fn shutdown_screen_rec() {
    let Ok(mut guard) = SCREEN.lock() else { return };
    if let Some(rec) = guard.take() {
        kill_capture(rec);
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VisualNote {
    pub t: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MeetingVideoAnalysis {
    pub visuals: Vec<VisualNote>,
    pub speakers: Vec<(f64, String)>,
}

const FRAME_CAP: usize = 40;
const SPEAKER_FRAME_CAP: usize = 80;
const SPEAKER_FRAME_SECS: u32 = 30;

/// Trimmed tile-label name, or None for blank/implausible reads.
fn clean_speaker_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return None;
    }
    Some(name.to_string())
}

fn speaker_prompt() -> &'static str {
    "This is a frame from a screen recording of a Microsoft Teams meeting. If one \
     participant tile is highlighted or outlined as the person actively speaking, reply \
     with the name shown on that tile's label, exactly as written. If no one is clearly \
     highlighted as speaking, or this is not a video-call view, reply with an empty name."
}

/// pts_time values from ffmpeg showinfo stderr, in order.
fn parse_showinfo(stderr: &str) -> Vec<f64> {
    stderr
        .lines()
        .filter_map(|l| {
            let i = l.find("pts_time:")?;
            l[i + 9..].split_whitespace().next()?.parse::<f64>().ok()
        })
        .collect()
}

/// Evenly thin to `cap`, always keeping first and last. Returns (index, pts).
fn thin_to_cap(pts: &[f64], cap: usize) -> Vec<(usize, f64)> {
    if pts.len() <= cap {
        return pts.iter().copied().enumerate().collect();
    }
    (0..cap)
        .map(|k| {
            let i = k * (pts.len() - 1) / (cap - 1);
            (i, pts[i])
        })
        .collect()
}

fn describe_prompt() -> &'static str {
    "This is a frame from a screen recording of a meeting. Describe what is shown in 1-2 \
     sentences: slide title and key bullet points if it's a slide, or what app/content is \
     being demonstrated. If it is only a video-call grid of faces with nothing presented, \
     reply with an empty text."
}

pub fn analyze_meeting_video_impl(
    path: &str,
    ollama: Option<&str>,
    cloud: Option<crate::sizzle::CloudVision>,
) -> Result<MeetingVideoAnalysis, String> {
    let video = std::path::Path::new(path);
    if !video.exists() {
        return Err(format!("video not found: {path}"));
    }
    let frames = video.with_extension("frames");
    std::fs::create_dir_all(&frames).map_err(|e| e.to_string())?;
    // Frames dir is scratch: once it exists, remove it on every exit path.
    let backend = crate::sizzle::backend_from(ollama, cloud);
    let result = extract_and_describe(path, &backend, &frames);
    let _ = std::fs::remove_dir_all(&frames);
    result
}

fn extract_and_describe(
    path: &str,
    backend: &crate::sizzle::VisionBackend,
    frames: &std::path::Path,
) -> Result<MeetingVideoAnalysis, String> {
    // One pass: keep frame 0 + frames where the scene actually changed.
    let mut c = Command::new("ffmpeg");
    c.args(["-y", "-i", path, "-vf"])
        .arg("select='eq(n,0)+gt(scene,0.05)',showinfo")
        .args(["-vsync", "vfr", "-q:v", "4"])
        .arg(frames.join("f_%04d.jpg"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    commands::no_window(&mut c);
    let out = c.output().map_err(|e| format!("ffmpeg failed: {e}"))?;
    let pts = parse_showinfo(&String::from_utf8_lossy(&out.stderr));

    // Second pass: periodic Teams-tile frames for speaker identification.
    let mut c2 = Command::new("ffmpeg");
    c2.args(["-y", "-i", path, "-vf"])
        .arg(format!("fps=1/{SPEAKER_FRAME_SECS},showinfo"))
        .args(["-vsync", "vfr", "-q:v", "4"])
        .arg(frames.join("s_%04d.jpg"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    commands::no_window(&mut c2);
    let speaker_pts = match c2.output() {
        Ok(out2) => parse_showinfo(&String::from_utf8_lossy(&out2.stderr)),
        Err(_) => vec![], // speaker pass is best-effort; visuals must survive
    };

    if pts.is_empty() && speaker_pts.is_empty() {
        return Ok(MeetingVideoAnalysis { visuals: vec![], speakers: vec![] });
    }

    let mut started = None;
    if let crate::sizzle::VisionBackend::Ollama(base) = backend {
        started = crate::sizzle::ensure_ollama("", base)?;
        if let Err(e) = crate::sizzle::check_ollama(base) {
            // Don't orphan an Ollama we just spawned — a plain `?` here would
            // skip the teardown below and leave the model pinned in VRAM.
            if let Some(child) = started.take() {
                crate::sizzle::stop_ollama(child);
            }
            return Err(e);
        }
    }
    let result = (|| {
        let mut notes = vec![];
        for (i, t) in thin_to_cap(&pts, FRAME_CAP) {
            let jpg = frames.join(format!("f_{:04}.jpg", i + 1));
            let Ok(bytes) = std::fs::read(&jpg) else { continue };
            let b64 = commands::base64_encode(&bytes);
            let ans = crate::sizzle::vision_chat(
                backend,
                describe_prompt(),
                &[b64],
                serde_json::json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}),
            )?;
            let text = serde_json::from_str::<serde_json::Value>(&ans)
                .ok()
                .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
                .unwrap_or_default();
            let text = text.trim().to_string();
            if !text.is_empty() {
                notes.push(VisualNote { t, text });
            }
        }

        let mut speakers = vec![];
        'speakers: for (i, t) in thin_to_cap(&speaker_pts, SPEAKER_FRAME_CAP) {
            let jpg = frames.join(format!("s_{:04}.jpg", i + 1));
            let Ok(bytes) = std::fs::read(&jpg) else { continue };
            let b64 = commands::base64_encode(&bytes);
            let ans = match crate::sizzle::vision_chat(
                backend,
                speaker_prompt(),
                &[b64],
                serde_json::json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}),
            ) {
                Ok(a) => a,
                // Best-effort: keep the visuals and what we have; hints degrade.
                Err(_) => break 'speakers,
            };
            let name = serde_json::from_str::<serde_json::Value>(&ans)
                .ok()
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .unwrap_or_default();
            if let Some(name) = clean_speaker_name(&name) {
                speakers.push((t, name));
            }
        }
        Ok(MeetingVideoAnalysis { visuals: notes, speakers })
    })();
    if let Some(child) = started {
        crate::sizzle::stop_ollama(child);
    }
    result
}

#[tauri::command]
pub async fn analyze_meeting_video(
    path: String,
    ollama: Option<String>,
    cloud: Option<crate::sizzle::CloudVision>,
) -> Result<MeetingVideoAnalysis, String> {
    tauri::async_runtime::spawn_blocking(move || analyze_meeting_video_impl(&path, ollama.as_deref(), cloud))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live probe: run the real PowerShell listing on this machine. On any
    /// desktop session at least one window (this terminal, explorer, …)
    /// should come back — an empty list here means the pipeline broke.
    /// `cargo test -- --ignored --nocapture real_window_list`
    #[test]
    #[ignore = "spawns PowerShell — run explicitly"]
    fn real_window_list() {
        let ws = list_capture_windows_impl().expect("listing failed");
        let with_thumb = ws.iter().filter(|w| w.thumb.is_some()).count();
        eprintln!("{} windows, {} with thumbnails:", ws.len(), with_thumb);
        for w in &ws {
            let t = w.thumb.as_ref().map(|t| format!("{}b b64", t.len())).unwrap_or("no thumb".into());
            eprintln!("  [{}] {} ({t})", w.app, w.title);
        }
        assert!(!ws.is_empty(), "window listing came back empty on a live desktop");
        assert!(with_thumb > 0, "no window produced a thumbnail on a live desktop");
    }

    /// Live probe for the black-video bug: record a real GPU-composited window
    /// (Teams if open, else any window with a thumbnail) for ~4s through the
    /// actual start/stop path, then assert the assembled mp4 is not black.
    /// gdigrab produced YAVG ≈ 16 (pure black in limited range) for Teams.
    /// `cargo test -- --ignored --nocapture real_screen_cap`
    #[test]
    #[ignore = "records the live desktop — run explicitly"]
    fn real_screen_cap() {
        let ws = list_capture_windows_impl().expect("listing failed");
        let w = ws
            .iter()
            .find(|w| w.app == "ms-teams" && w.thumb.is_some())
            .or_else(|| ws.iter().find(|w| w.thumb.is_some()))
            .expect("no capturable window on a live desktop");
        eprintln!("capturing [{}] {}", w.app, w.title);
        start_screen_record_impl(w.title.clone()).expect("start failed");
        std::thread::sleep(std::time::Duration::from_secs(4));
        let path = stop_screen_record_impl()
            .expect("stop failed")
            .expect("no video came back — capture produced zero frames");
        let out = Command::new("ffmpeg")
            .args(["-i", &path, "-vf", "signalstats,metadata=print", "-f", "null", "-"])
            .output()
            .expect("ffmpeg failed");
        let stderr = String::from_utf8_lossy(&out.stderr);
        let yavgs: Vec<f64> = stderr
            .lines()
            .filter_map(|l| l.split("signalstats.YAVG=").nth(1))
            .filter_map(|v| v.trim().parse().ok())
            .collect();
        let _ = std::fs::remove_file(&path);
        assert!(!yavgs.is_empty(), "no YAVG stats — video unreadable?\n{stderr}");
        let mean = yavgs.iter().sum::<f64>() / yavgs.len() as f64;
        eprintln!("{} frames, mean luma {mean:.1}", yavgs.len());
        assert!(mean > 20.0, "video is black (mean luma {mean:.1})");
    }

    #[test]
    fn window_list_parses_array_and_single_object() {
        let many = r#"[{"ProcessName":"Zoom","MainWindowTitle":"Zoom Meeting","Thumb":"aGk="},
                       {"ProcessName":"chrome","MainWindowTitle":"Meet - x","Thumb":null}]"#;
        let one = r#"{"ProcessName":"Zoom","MainWindowTitle":"Zoom Meeting"}"#;
        let many = parse_window_list(many);
        assert_eq!(many.len(), 2);
        assert_eq!(many[0].thumb.as_deref(), Some("aGk="));
        assert_eq!(many[1].thumb, None); // null Thumb (capture failed) → None
        let w = &parse_window_list(one)[0];
        assert_eq!(w.app, "Zoom");
        assert_eq!(w.title, "Zoom Meeting");
        assert_eq!(w.thumb, None); // missing Thumb key tolerated
        assert!(parse_window_list("not json").is_empty());
        // Windows with empty titles are dropped.
        let blank = r#"[{"ProcessName":"x","MainWindowTitle":""}]"#;
        assert!(parse_window_list(blank).is_empty());
    }

    #[test]
    fn showinfo_pts_parse_and_thinning() {
        let stderr = "\
[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       duration_time:0.1\n\
noise line\n\
[Parsed_showinfo_1 @ 0x1] n:   1 pts:  12345 pts_time:34.56   duration_time:0.1\n\
[Parsed_showinfo_1 @ 0x1] n:   2 pts:  99999 pts_time:71.2    duration_time:0.1\n";
        assert_eq!(parse_showinfo(stderr), vec![0.0, 34.56, 71.2]);

        let v: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let t = thin_to_cap(&v, 40);
        assert_eq!(t.len(), 40);
        assert_eq!(t[0].0, 0);            // keeps the first frame index
        assert_eq!(t.last().unwrap().0, 99); // and the last
        assert_eq!(thin_to_cap(&v[..5], 40).len(), 5); // under cap untouched
    }

    #[test]
    fn speaker_name_sanitation() {
        assert_eq!(clean_speaker_name("  Jane Doe  "), Some("Jane Doe".to_string()));
        assert_eq!(clean_speaker_name(""), None);
        assert_eq!(clean_speaker_name("   "), None);
        assert_eq!(clean_speaker_name(&"x".repeat(61)), None); // misread
        assert_eq!(clean_speaker_name(&"x".repeat(60)), Some("x".repeat(60)));
        // 60 chars but 120 bytes (multibyte): cap is chars, not bytes.
        assert!(clean_speaker_name(&"é".repeat(40)).is_some());
    }
}
