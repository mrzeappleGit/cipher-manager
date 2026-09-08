//! cipherSizzle — self-hosted auto-highlights, folded into cipherManager.
//!
//! Native Rust port of the standalone cipherSizzle tool (no Python dependency).
//! The game-agnostic signal for "best moment" is an audio-loudness spike; we read
//! ffmpeg's `astats` RMS meter and flag windows that jump above the stream's own
//! baseline, then cut clips with ffmpeg (optionally downloading a VOD via yt-dlp).
//!
//! Two entry points, both dual-mode (desktop invoke + web /api via serve.rs):
//!   - `detect_highlights` — fast one-shot on a LOCAL file → ranked timestamps.
//!   - `start_sizzle` — the full pipeline (fetch → detect → cut → mashup) as a
//!     background job reusing the existing jobs engine, so the Jobs panel shows
//!     progress; `list_clips` reads the results when it finishes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::claude;
use crate::commands;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub start: f64, // seconds, padded
    pub end: f64,
    pub score: f64, // dB above the stream's median loudness
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub name: String,
    pub path: String,
    pub vertical: bool,
    /// AI clip score 0–100 when `ai_scored`, else dB over baseline (old jobs).
    /// 0 for the mashup/compilation file.
    pub score: f64,
    /// Loudness signal (dB over baseline); 0 when the window had no audio spike.
    pub audio_score: f64,
    /// Short model explanation for AI-scored clips; empty otherwise.
    pub reason: String,
    /// True when the local vision model produced `score`/`reason`.
    pub ai_scored: bool,
    pub start: f64,
    pub end: f64,
}

/// Per-job sidecar (`meta.json`): the resolved source video plus each clip's
/// bounds and score. Lets us re-cut ("Adjust start & end") and sort by score.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct JobMeta {
    source: String,
    clips: Vec<ClipMeta>,
    /// Facecam layout the job's vertical clips were cut with (re-cuts reuse it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    facecam: Option<FacecamLayout>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ClipMeta {
    name: String,
    start: f64,
    end: f64,
    /// AI score 0–100 for `ai_scored` clips; dB over baseline in old sidecars.
    score: f64,
    #[serde(default)]
    audio_score: f64,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    ai_scored: bool,
}

/// Normalized (0–1) crop box over the source frame.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct CamBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Facecam-on-top vertical layout: cam fills the top 1080×640, game the
/// bottom 1080×1280 of the 9:16 output.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct FacecamLayout {
    pub cam: CamBox,
    pub game: CamBox,
}

/// Video stream dimensions via ffprobe.
fn probe_dims(path: &str) -> Result<(u32, u32), String> {
    let mut c = Command::new("ffprobe");
    c.args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
        .arg(path);
    commands::no_window(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("ffprobe not available (is it on PATH?): {e}"))?;
    let s = String::from_utf8_lossy(&out.stdout);
    let mut it = s.trim().split(',');
    let w = it.next().and_then(|x| x.trim().parse().ok());
    let h = it.next().and_then(|x| x.trim().parse().ok());
    match (w, h) {
        (Some(w), Some(h)) => Ok((w, h)),
        _ => Err("could not read the video dimensions".into()),
    }
}

/// filter_complex for the stacked 1080×1920 output. Boxes are de-normalized
/// against the source dims and clamped fully inside the frame; the scale
/// step fixes the final (even) dimensions, so crop sizes need no rounding.
fn vstack_filter(l: &FacecamLayout, width: u32, height: u32) -> String {
    let px = |b: &CamBox| {
        let (fw, fh) = (width as f64, height as f64);
        let bw = (b.w.clamp(0.05, 1.0) * fw).round();
        let bh = (b.h.clamp(0.05, 1.0) * fh).round();
        let bx = (b.x.clamp(0.0, 1.0) * fw).round().min(fw - bw).max(0.0);
        let by = (b.y.clamp(0.0, 1.0) * fh).round().min(fh - bh).max(0.0);
        (bw as u32, bh as u32, bx as u32, by as u32)
    };
    let (cw, ch, cx, cy) = px(&l.cam);
    let (gw, gh, gx, gy) = px(&l.game);
    format!(
        "[0:v]crop={cw}:{ch}:{cx}:{cy},scale=1080:640[cam];[0:v]crop={gw}:{gh}:{gx}:{gy},scale=1080:1280[game];[cam][game]vstack=inputs=2[v]"
    )
}

fn meta_path(job_dir: &Path) -> PathBuf {
    job_dir.join("meta.json")
}

fn read_meta(job_dir: &Path) -> JobMeta {
    std::fs::read_to_string(meta_path(job_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_meta(job_dir: &Path, m: &JobMeta) {
    if let Ok(s) = serde_json::to_string_pretty(m) {
        let _ = std::fs::write(meta_path(job_dir), s);
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

// ---------------------------------------------------------------------------
// Pure detection logic — direct port of highlights.py `find_highlights`.
// ---------------------------------------------------------------------------

/// From a time-ordered `(t, loudness_dB)` series, return ranked highlight windows.
/// A moment is "hot" when loudness exceeds the median baseline by `thresh_db`.
pub fn find_highlights(
    series: &[(f64, f64)],
    top_n: usize,
    thresh_db: f64,
    min_gap: f64,
    pad: f64,
    min_len: f64,
) -> Vec<Highlight> {
    if series.is_empty() {
        return vec![];
    }
    // Median matching Python's statistics.median: mean of the two middle values
    // on an even-length series, else the middle value.
    let mut loud: Vec<f64> = series.iter().map(|&(_, m)| m).collect();
    loud.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = loud.len();
    let baseline = if n % 2 == 1 {
        loud[n / 2]
    } else {
        (loud[n / 2 - 1] + loud[n / 2]) / 2.0
    };

    let hot: Vec<(f64, f64)> = series
        .iter()
        .copied()
        .filter(|&(_, m)| m >= baseline + thresh_db)
        .collect();
    if hot.is_empty() {
        return vec![];
    }

    // Merge consecutive hot points (gap <= min_gap) into (start, end, peak) windows.
    let mut windows: Vec<(f64, f64, f64)> = vec![];
    let (mut s, mut e, mut peak) = (hot[0].0, hot[0].0, hot[0].1);
    for &(t, m) in &hot[1..] {
        if t - e <= min_gap {
            e = t;
            peak = peak.max(m);
        } else {
            windows.push((s, e, peak));
            s = t;
            e = t;
            peak = m;
        }
    }
    windows.push((s, e, peak));

    let mut out: Vec<Highlight> = windows
        .into_iter()
        .map(|(s, e, peak)| {
            let start = (s - pad).max(0.0);
            let mut end = e + pad;
            if end - start < min_len {
                end = start + min_len;
            }
            Highlight {
                start: round2(start),
                end: round2(end),
                score: round2(peak - baseline),
            }
        })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(top_n);
    out
}

// ---------------------------------------------------------------------------
// Visual highlight analysis — Qwen3-VL through local Ollama.
//
// "Make clips" samples the WHOLE timeline as low-res contact sheets, has the
// vision model coarse-score every 60s block, unions the best blocks with the
// loudness windows, then fine-scores each candidate (12 frames) to pick and
// bound the final clips. Loudness is kept only as a candidate source and a
// sort tie-breaker. Traffic goes to local Ollama by default, or to a
// user-configured LAN host (e.g. the streaming PC's 4090).
// ---------------------------------------------------------------------------

const MODEL: &str = "qwen3-vl:30b";
const DEFAULT_OLLAMA: &str = "http://127.0.0.1:11434";
const COARSE_BLOCK_SECS: f64 = 60.0;
const COARSE_FRAMES_PER_BLOCK: usize = 9;
const COARSE_BLOCKS_PER_REQUEST: usize = 4;
const FINE_FRAMES_PER_CANDIDATE: usize = 12;
const CANDIDATE_MULTIPLIER: usize = 3;
/// Same padding / minimum length the loudness detector uses (see run_sizzle_job).
const CLIP_PAD: f64 = 4.0;
const MIN_CLIP_LEN: f64 = 3.0;

/// The shared scoring rubric for both scan passes. Wording matters: an earlier
/// version rewarded "visible action", so vibrant/flashy games scored high on
/// every block — hence the explicit baseline rule and anchored scale. Focused
/// on humor + impressive plays by user request (2026-07-23).
/// ponytail: focus is hardcoded; make it a Settings dropdown (funny/hype/all)
/// if a different stream ever needs a different lens.
const RUBRIC: &str = "Score 0-100 for clip potential. You are hunting TWO kinds of moments: \
(1) FUNNY — jokes that land, fails, absurd or chaotic surprises, big streamer laughter or \
reactions; (2) IMPRESSIVE GAMEPLAY — clutch plays, high-skill outplays, perfect timing, rare \
feats. A high score requires a specific EVENT of one of those kinds that you could name. \
Events of other kinds (calm wins, reveals, routine progress) cap at 55. Judge CHANGE across \
the frames, not how busy or colorful any single frame is — flashy, vibrant, fast-moving \
gameplay is this game's normal baseline and caps at 40 unless a discrete moment clearly \
stands out from the neighboring frames. The moment must also work as a standalone clip. \
Menus, loading screens, and dead time score below 15. Calibrate: 85+ = a once-a-stream \
hilarious or jaw-dropping moment, 60-79 = genuinely funny or impressive, clip-worthy, \
40-59 = ordinary play, below 40 = nothing happening.";

#[derive(Deserialize)]
struct CoarseResp {
    blocks: Vec<CoarseBlock>,
}

// The coarse schema still demands a `reason` (it makes the model justify its
// score); serde just ignores it here — only fine-scan reasons reach the UI.
#[derive(Deserialize)]
struct CoarseBlock {
    id: String,
    score: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FineResp {
    candidates: Vec<FineCand>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FineCand {
    id: String,
    score: f64,
    #[serde(default)]
    reason: String,
    start_frame: i64,
    end_frame: i64,
}

/// A window worth fine-scanning: a top visual block and/or a loud audio window.
#[derive(Clone, Debug, PartialEq)]
struct Candidate {
    start: f64,
    end: f64,
    /// dB over baseline from the loudness scan; 0 for purely visual candidates.
    audio: f64,
}

/// A fine-scanned window ready for ranking and cutting.
#[derive(Clone, Debug)]
struct ScoredWindow {
    start: f64,
    end: f64,
    score: f64,
    audio: f64,
    reason: String,
}

/// Parse a code-owned id like `block-0004` back to its index; reject anything
/// unknown, malformed, or out of range (model output is untrusted).
fn id_index(id: &str, prefix: &str, max: usize) -> Option<usize> {
    let idx: usize = id.strip_prefix(prefix)?.parse().ok()?;
    (idx < max).then_some(idx)
}

fn valid_score(s: f64) -> bool {
    s.is_finite() && (0.0..=100.0).contains(&s)
}

/// Map model frame indexes (0-based, inclusive) back to padded, clamped source
/// timestamps. Frames are evenly spaced over the window: frame k starts at
/// `win_start + k * win_len / frames`. Rejects out-of-range or inverted picks.
fn refine_window(
    win_start: f64,
    win_len: f64,
    start_frame: i64,
    end_frame: i64,
    frames: usize,
    duration: f64,
) -> Option<(f64, f64)> {
    if start_frame < 0 || end_frame < start_frame || end_frame >= frames as i64 {
        return None;
    }
    let step = win_len / frames as f64;
    let s = (win_start + start_frame as f64 * step - CLIP_PAD).max(0.0);
    let mut e = (win_start + (end_frame as f64 + 1.0) * step + CLIP_PAD).min(duration);
    if e - s < MIN_CLIP_LEN {
        e = (s + MIN_CLIP_LEN).min(duration);
    }
    (e > s).then(|| (round2(s), round2(e)))
}

/// Merge overlapping candidate windows (sorted sweep), keeping the strongest
/// audio signal of the merged group.
fn merge_windows(mut cands: Vec<Candidate>) -> Vec<Candidate> {
    cands.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Candidate> = vec![];
    for c in cands {
        match out.last_mut() {
            Some(last) if c.start < last.end => {
                last.end = last.end.max(c.end);
                last.audio = last.audio.max(c.audio);
            }
            _ => out.push(c),
        }
    }
    out
}

/// AI score is the primary key, loudness the tie-breaker; overlapping windows
/// keep only the best-scored one; limit to `top_n`.
fn rank(mut wins: Vec<ScoredWindow>, top_n: usize) -> Vec<ScoredWindow> {
    wins.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.audio.partial_cmp(&a.audio).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut kept: Vec<ScoredWindow> = vec![];
    for w in wins {
        if kept.len() == top_n {
            break;
        }
        if kept.iter().all(|k| w.end <= k.start || w.start >= k.end) {
            kept.push(w);
        }
    }
    kept
}

/// Source duration in seconds via ffprobe.
fn probe_duration(path: &str) -> Result<f64, String> {
    let mut c = Command::new("ffprobe");
    c.args(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"])
        .arg(path);
    commands::no_window(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("ffprobe not available (is it on PATH?): {e}"))?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .map_err(|_| "could not read the video duration".to_string())
}

/// Extract `frames` evenly spaced low-res frames from `[start, start+len)` into
/// one JPEG contact sheet in chronological reading order (L→R, T→B).
fn extract_sheet(video: &str, out: &Path, start: f64, len: f64, frames: usize, cols: usize) -> Result<(), String> {
    let rows = (frames + cols - 1) / cols;
    let mut c = Command::new("ffmpeg");
    c.arg("-y")
        .arg("-ss")
        .arg(start.to_string())
        .arg("-t")
        .arg(len.to_string())
        .arg("-i")
        .arg(video)
        .args([
            "-vf",
            &format!("fps={:.6},scale=320:-2,tile={cols}x{rows}", frames as f64 / len),
            "-frames:v",
            "1",
            "-q:v",
            "7",
        ])
        .arg(out);
    run_stage(c).map_err(|e| format!("frame sampling failed: {e}"))?;
    if !out.is_file() {
        return Err("frame sampling produced no image".into());
    }
    Ok(())
}

/// One structured chat call to local Ollama; returns the message content
/// (a JSON string constrained by `format`). Reuses the http_proxy localhost
/// allowlist — nothing leaves the machine.
pub(crate) fn ollama_chat(base: &str, prompt: &str, images: &[String], format: serde_json::Value) -> Result<String, String> {
    let body = serde_json::json!({
        "model": MODEL,
        "stream": false,
        "options": { "temperature": 0 },
        "format": format,
        "messages": [{ "role": "user", "content": prompt, "images": images }],
    });
    let mut headers = std::collections::HashMap::new();
    headers.insert("Content-Type".to_string(), "application/json".to_string());
    // A cold-started server's first reply can be empty (done_reason "load"),
    // so retry empty content a couple of times before giving up.
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        let resp = commands::http_proxy(format!("{base}/api/chat"), "POST".into(), headers.clone(), body.to_string())
            .map_err(|e| format!("Ollama request failed — is Ollama still running? ({e})"))?;
        if resp.status != 200 {
            let short: String = resp.body.chars().take(300).collect();
            return Err(format!("Ollama returned HTTP {}: {short}", resp.status));
        }
        let v: serde_json::Value =
            serde_json::from_str(&resp.body).map_err(|e| format!("bad Ollama response: {e}"))?;
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| "Ollama response had no message content".to_string())?;
        if !content.trim().is_empty() {
            return Ok(content.to_string());
        }
    }
    Err("Ollama returned empty content 3 times in a row".into())
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct CloudVision {
    pub kind: String,
    pub url: String,
    pub model: String,
    pub headers: std::collections::HashMap<String, String>,
}

pub(crate) enum VisionBackend {
    Ollama(String),
    Cloud(CloudVision),
}

/// `cloud` wins when both are given (the frontend only sends one).
pub(crate) fn backend_from(ollama: Option<&str>, cloud: Option<CloudVision>) -> VisionBackend {
    match cloud {
        Some(c) => VisionBackend::Cloud(c),
        None => VisionBackend::Ollama(ollama_base(ollama)),
    }
}

fn backend_id(backend: &VisionBackend) -> String {
    match backend {
        VisionBackend::Ollama(_) => format!("ollama:{MODEL}"),
        VisionBackend::Cloud(c) => format!("cloud:{}#{}", c.url, c.model),
    }
}

/// Cloud models can wrap JSON in prose or fences — take the outermost {…}.
fn extract_json(s: &str) -> &str {
    match (s.find('{'), s.rfind('}')) {
        (Some(a), Some(b)) if b > a => &s[a..=b],
        _ => s,
    }
}

fn openai_body(model: &str, prompt: &str, images: &[String]) -> serde_json::Value {
    let mut content = vec![serde_json::json!({"type": "text", "text": prompt})];
    for b64 in images {
        content.push(serde_json::json!({
            "type": "image_url",
            "image_url": {"url": format!("data:image/jpeg;base64,{b64}")}
        }));
    }
    serde_json::json!({
        "model": model, "temperature": 0, "max_tokens": 4000,
        "messages": [{"role": "user", "content": content}],
    })
}

fn anthropic_body(model: &str, prompt: &str, images: &[String]) -> serde_json::Value {
    let mut content: Vec<serde_json::Value> = images
        .iter()
        .map(|b64| serde_json::json!({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}
        }))
        .collect();
    content.push(serde_json::json!({"type": "text", "text": prompt}));
    serde_json::json!({
        "model": model, "max_tokens": 4000,
        "messages": [{"role": "user", "content": content}],
    })
}

/// One choke point for every vision request. Ollama keeps its native format
/// schema + retry behavior; cloud backends get the schema appended to the
/// prompt and a lenient {…} extraction so callers' serde parsing works the
/// same either way.
pub(crate) fn vision_chat(
    backend: &VisionBackend,
    prompt: &str,
    images: &[String],
    schema: serde_json::Value,
) -> Result<String, String> {
    let c = match backend {
        VisionBackend::Ollama(base) => return ollama_chat(base, prompt, images, schema),
        VisionBackend::Cloud(c) => c,
    };
    let prompt = format!("{prompt}\n\nReply with ONLY a JSON object matching this schema: {schema}");
    let body = match c.kind.as_str() {
        "anthropic" => anthropic_body(&c.model, &prompt, images),
        _ => openai_body(&c.model, &prompt, images),
    };
    let mut headers = c.headers.clone();
    headers.insert("Content-Type".to_string(), "application/json".to_string());
    // Two kinds of transient failure are worth retrying with backoff: rate
    // limits / overload (429, 5xx — a VOD scan fires dozens of requests, and
    // Gemini sheds load with 503s under demand spikes) and a chatty/truncated
    // reply that isn't valid JSON. Hard 4xx errors fail fast.
    let mut last_err = String::new();
    for attempt in 0..4 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_secs(2u64 << attempt)); // 4s, 8s, 16s
        }
        let resp = commands::http_proxy(c.url.clone(), "POST".into(), headers.clone(), body.to_string())
            .map_err(|e| format!("cloud AI request failed: {e}"))?;
        if resp.status == 429 || resp.status >= 500 {
            let short: String = resp.body.chars().take(300).collect();
            last_err = format!("cloud AI returned HTTP {} (transient): {short}", resp.status);
            continue;
        }
        if resp.status != 200 {
            let short: String = resp.body.chars().take(300).collect();
            return Err(format!("cloud AI returned HTTP {}: {short}", resp.status));
        }
        let v: serde_json::Value =
            serde_json::from_str(&resp.body).map_err(|e| format!("bad cloud AI response: {e}"))?;
        let content = match c.kind.as_str() {
            "anthropic" => v["content"][0]["text"].as_str(),
            _ => v["choices"][0]["message"]["content"].as_str(),
        }
        .ok_or_else(|| "cloud AI response had no content".to_string())?;
        let extracted = extract_json(content).to_string();
        if serde_json::from_str::<serde_json::Value>(&extracted).is_ok() {
            return Ok(extracted);
        }
        last_err = format!(
            "cloud AI reply wasn't valid JSON: {}",
            extracted.chars().take(120).collect::<String>()
        );
    }
    Err(format!("{last_err} — after 4 attempts; try again later or pick another model in the AI backend picker"))
}

/// Normalize the user's Ollama URL setting: trimmed, no trailing slash,
/// empty → local default.
pub(crate) fn ollama_base(url: Option<&str>) -> String {
    let u = url.unwrap_or("").trim().trim_end_matches('/');
    if u.is_empty() { DEFAULT_OLLAMA.into() } else { u.into() }
}

/// True when the base URL points at this machine — the only case where we can
/// (and should) manage the `ollama serve` process lifecycle ourselves.
fn ollama_is_local(base: &str) -> bool {
    let host = base
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split([':', '/'])
        .next()
        .unwrap_or("");
    host == "localhost" || host == "127.0.0.1"
}

/// Kill the spawned `ollama serve` AND its children. Killing only the parent
/// orphans the llama-server.exe runner, which keeps the model pinned in VRAM.
pub(crate) fn stop_ollama(mut child: std::process::Child) {
    #[cfg(target_os = "windows")]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &child.id().to_string(), "/T", "/F"]);
        commands::no_window(&mut c);
        let _ = c.output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Is anything answering on the Ollama port?
fn ollama_up(base: &str) -> bool {
    commands::http_proxy(format!("{base}/api/tags"), "GET".into(), Default::default(), String::new())
        .is_ok_and(|r| r.status == 200)
}

/// Start `ollama serve` if nothing is listening. Returns the child when *we*
/// started it, so the job can stop it (and free the VRAM) when it finishes;
/// None means it was already running (or is remote) and we leave it alone.
pub(crate) fn ensure_ollama(id: &str, base: &str) -> Result<Option<std::process::Child>, String> {
    if !ollama_is_local(base) || ollama_up(base) {
        return Ok(None);
    }
    commands::job_log(id, "Starting Ollama…");
    let mut c = Command::new("ollama");
    c.arg("serve").stdout(Stdio::null()).stderr(Stdio::null());
    commands::no_window(&mut c);
    let child = c
        .spawn()
        .map_err(|e| format!("couldn't start Ollama ({e}) — is it installed?"))?;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if ollama_up(base) {
            return Ok(Some(child));
        }
    }
    stop_ollama(child);
    Err("started `ollama serve` but it never became reachable".into())
}

/// Cheap preflight so the user gets an actionable error before any frame work:
/// distinguishes "Ollama not running" from "model not pulled".
pub(crate) fn check_ollama(base: &str) -> Result<(), String> {
    let resp = commands::http_proxy(format!("{base}/api/tags"), "GET".into(), Default::default(), String::new())
        .map_err(|_| format!("Ollama isn't reachable at {base} — start Ollama there and try again"))?;
    if resp.status != 200 {
        return Err(format!("Ollama tags check failed (HTTP {})", resp.status));
    }
    let v: serde_json::Value =
        serde_json::from_str(&resp.body).map_err(|e| format!("bad Ollama tags response: {e}"))?;
    let have = v["models"]
        .as_array()
        .is_some_and(|a| a.iter().any(|m| m["name"].as_str() == Some(MODEL)));
    if have {
        Ok(())
    } else {
        Err(format!("model {MODEL} isn't installed on {base} — run: ollama pull {MODEL}"))
    }
}

fn coarse_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["blocks"],
        "properties": { "blocks": { "type": "array", "items": {
            "type": "object",
            "required": ["id", "score", "reason"],
            "properties": {
                "id": { "type": "string" },
                "score": { "type": "number" },
                "reason": { "type": "string" }
            }
        }}}
    })
}

fn fine_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["candidates"],
        "properties": { "candidates": { "type": "array", "items": {
            "type": "object",
            "required": ["id", "score", "reason", "startFrame", "endFrame"],
            "properties": {
                "id": { "type": "string" },
                "score": { "type": "number" },
                "reason": { "type": "string" },
                "startFrame": { "type": "integer" },
                "endFrame": { "type": "integer" }
            }
        }}}
    })
}

/// Sidecar cache of the coarse scan (`<video>.scan.json`) so Reanalyze skips
/// the expensive whole-VOD pass. Holds the FULL untruncated score list, so a
/// bigger top_n on the rerun still has every block to pick from. Invalidated
/// when the video's size or the scan parameters (rubric/model/geometry) change.
#[derive(Serialize, Deserialize)]
struct ScanCache {
    params: String,
    video_len: u64,
    scores: Vec<(usize, f64)>,
}

fn scan_params(backend: &VisionBackend) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    RUBRIC.hash(&mut h);
    backend_id(backend).hash(&mut h);
    format!("{COARSE_BLOCK_SECS}x{COARSE_FRAMES_PER_BLOCK}-{:016x}", h.finish())
}

fn read_scan_cache(video: &str, backend: &VisionBackend) -> Option<Vec<(usize, f64)>> {
    let len = std::fs::metadata(video).ok()?.len();
    let raw = std::fs::read_to_string(format!("{video}.scan.json")).ok()?;
    let c: ScanCache = serde_json::from_str(&raw).ok()?;
    (c.params == scan_params(backend) && c.video_len == len).then_some(c.scores)
}

fn write_scan_cache(video: &str, scores: &[(usize, f64)], backend: &VisionBackend) {
    let Ok(m) = std::fs::metadata(video) else { return };
    let c = ScanCache { params: scan_params(backend), video_len: m.len(), scores: scores.to_vec() };
    if let Ok(s) = serde_json::to_string(&c) {
        let _ = std::fs::write(format!("{video}.scan.json"), s);
    }
}

/// The expensive whole-VOD pass: sample a contact sheet per block, score every
/// block with the vision model, cache the full score list next to the video.
fn coarse_scan(
    id: &str,
    video: &str,
    analysis: &Path,
    duration: f64,
    backend: &VisionBackend,
) -> Result<Vec<(usize, f64)>, String> {
    // Coarse sheets over the COMPLETE timeline — a quiet block is never skipped.
    commands::job_log(id, "Sampling video…");
    let n_blocks = (duration / COARSE_BLOCK_SECS).ceil().max(1.0) as usize;
    let mut sheets: Vec<(usize, f64, f64, PathBuf)> = vec![]; // (block, start, len, jpg)
    for b in 0..n_blocks {
        // Long VODs mean hundreds of sheets (~1s each) — show a pulse.
        if b > 0 && b % 25 == 0 {
            commands::job_log(id, &format!("Sampling video… {b}/{n_blocks}"));
        }
        let start = b as f64 * COARSE_BLOCK_SECS;
        let len = (duration - start).min(COARSE_BLOCK_SECS);
        if len < 1.0 {
            continue;
        }
        let p = analysis.join(format!("block_{b:04}.jpg"));
        extract_sheet(video, &p, start, len, COARSE_FRAMES_PER_BLOCK, 3)?;
        sheets.push((b, start, len, p));
    }
    if sheets.is_empty() {
        return Err("video is too short to sample".into());
    }

    // Coarse scan, batched sheets per request.
    let n_batches = (sheets.len() + COARSE_BLOCKS_PER_REQUEST - 1) / COARSE_BLOCKS_PER_REQUEST;
    let mut block_scores: Vec<(usize, f64)> = vec![];
    let mut skipped = 0usize;
    let mut last_err = String::new();
    for (bi, batch) in sheets.chunks(COARSE_BLOCKS_PER_REQUEST).enumerate() {
        commands::job_log(id, &format!("AI scan batch {}/{n_batches}…", bi + 1));
        let mut images = vec![];
        let mut lines = String::new();
        for (n, (b, start, len, p)) in batch.iter().enumerate() {
            let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
            images.push(commands::base64_encode(&bytes));
            lines.push_str(&format!(
                "Image {}: block \"block-{b:04}\" covering {start:.0}s–{:.0}s, one frame every {:.1}s starting at {start:.0}s.\n",
                n + 1,
                start + len,
                len / COARSE_FRAMES_PER_BLOCK as f64,
            ));
        }
        let prompt = format!(
            "You rate one-minute blocks of a video for how likely they contain a great short clip.\n\
             Each attached image is a contact sheet of {COARSE_FRAMES_PER_BLOCK} frames in chronological \
             reading order (left to right, top to bottom).\n{lines}{RUBRIC}\n\
             Return JSON with one entry per block using the exact block ids given."
        );
        // A batch that still fails after vision_chat's own retries (cloud
        // 503 bursts can outlast the backoff) skips its 4 minutes of VOD
        // instead of killing a long scan; the job fails only if EVERY batch
        // was lost.
        let scored = vision_chat(backend, &prompt, &images, coarse_schema())
            .map_err(|e| format!("AI scan batch {}/{n_batches}: {e}", bi + 1))
            .and_then(|content| {
                serde_json::from_str::<CoarseResp>(&content).map_err(|e| {
                    format!("AI scan batch {}/{n_batches}: malformed model response ({e})", bi + 1)
                })
            });
        match scored {
            Ok(resp) => {
                for blk in resp.blocks {
                    if let Some(idx) = id_index(&blk.id, "block-", n_blocks) {
                        if valid_score(blk.score) {
                            block_scores.push((idx, blk.score));
                        }
                    }
                }
            }
            Err(e) => {
                commands::job_log(id, &format!("{e} — skipping this batch"));
                skipped += 1;
                last_err = e;
            }
        }
    }
    if skipped == n_batches {
        return Err(last_err);
    }
    if skipped > 0 {
        commands::job_log(
            id,
            &format!("{skipped}/{n_batches} batches skipped after retries — those minutes weren't scored"),
        );
    }
    // A partial scan must not be memoized — a later Reanalyze should rescan
    // the blocks the outage swallowed.
    if skipped == 0 {
        write_scan_cache(video, &block_scores, backend);
    }
    Ok(block_scores)
}

/// The whole visual pass: coarse-scan every block, union with audio windows,
/// fine-scan each candidate, return the ranked top-N windows. Contact sheets
/// go under `analysis` (caller deletes it whatever happens).
fn visual_scan(
    id: &str,
    video: &str,
    analysis: &Path,
    audio_hl: &[Highlight],
    top_n: usize,
    backend: &VisionBackend,
    stt: Option<&SttConfig>,
) -> Result<Vec<ScoredWindow>, String> {
    let duration = probe_duration(video)?;
    let cap = top_n * CANDIDATE_MULTIPLIER;

    let mut block_scores: Vec<(usize, f64)> = match read_scan_cache(video, backend) {
        Some(s) => {
            commands::job_log(id, "Reusing cached AI scan for this video — skipping the full pass…");
            s
        }
        None => coarse_scan(id, video, analysis, duration, backend)?,
    };

    // Strongest visual blocks ∪ loud audio windows → merged fine-scan candidates.
    block_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    block_scores.dedup_by_key(|&mut (idx, _)| idx);
    block_scores.truncate(cap);
    let mut cands: Vec<Candidate> = audio_hl
        .iter()
        .map(|h| Candidate { start: h.start, end: h.end, audio: h.score })
        .collect();
    for &(idx, _) in &block_scores {
        let start = idx as f64 * COARSE_BLOCK_SECS;
        cands.push(Candidate { start, end: (start + COARSE_BLOCK_SECS).min(duration), audio: 0.0 });
    }
    let cands = merge_windows(cands);

    // Dialog first (spoken jokes are invisible to the vision passes), and
    // before the fine loop so WhisperX never shares the GPU with local vision.
    let dialogs: Vec<String> = match stt {
        Some(s) if commands::proxy_allowed(&s.url) => {
            candidate_dialogs(id, video, &cands, analysis, s)
        }
        _ => vec![],
    };

    // Fine scan: score + boundary refinement per candidate.
    let mut wins: Vec<ScoredWindow> = vec![];
    let mut fine_err: Option<String> = None;
    for (i, c) in cands.iter().enumerate() {
        commands::job_log(id, &format!("Refining candidate {}/{}…", i + 1, cands.len()));
        let len = (c.end - c.start).max(1.0);
        let p = analysis.join(format!("cand_{i:02}.jpg"));
        extract_sheet(video, &p, c.start, len, FINE_FRAMES_PER_CANDIDATE, 4)?;
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        let cid = format!("candidate-{i:02}");
        let dialog = dialogs
            .get(i)
            .filter(|d| !d.is_empty())
            .map(|d| {
                format!(
                    "\nWhat was said during this window (mic transcript): \"{d}\"\n\
                     Judge humor from this dialog plus visible reactions — spoken jokes rarely \
                     show on screen."
                )
            })
            .unwrap_or_default();
        let prompt = format!(
            "The attached contact sheet shows {FINE_FRAMES_PER_CANDIDATE} frames in chronological \
             reading order (left to right, top to bottom) for candidate \"{cid}\": frame 0 is at \
             {:.0}s, one frame every {:.1}s.\n{RUBRIC}{dialog}\n\
             Pick startFrame and endFrame (0-based, inclusive) bounding the single best moment, \
             give its score, and a short reason. Return JSON using the exact candidate id given.",
            c.start,
            len / FINE_FRAMES_PER_CANDIDATE as f64,
        );
        // Same skip-don't-die policy as the coarse batches: one candidate
        // lost to a cloud outage shouldn't sink the survivors.
        let resp: FineResp = match vision_chat(backend, &prompt, &[commands::base64_encode(&bytes)], fine_schema())
            .map_err(|e| format!("Refining candidate {}/{}: {e}", i + 1, cands.len()))
            .and_then(|content| {
                serde_json::from_str(&content).map_err(|e| {
                    format!("Refining candidate {}/{}: malformed model response ({e})", i + 1, cands.len())
                })
            }) {
            Ok(r) => r,
            Err(e) => {
                commands::job_log(id, &format!("{e} — skipping this candidate"));
                fine_err = Some(e);
                continue;
            }
        };
        for fc in resp.candidates {
            if id_index(&fc.id, "candidate-", cands.len()) != Some(i) || !valid_score(fc.score) {
                continue; // unknown/malformed id or score — reject the entry
            }
            if let Some((s, e)) =
                refine_window(c.start, len, fc.start_frame, fc.end_frame, FINE_FRAMES_PER_CANDIDATE, duration)
            {
                wins.push(ScoredWindow {
                    start: s,
                    end: e,
                    score: fc.score,
                    audio: c.audio,
                    reason: fc.reason.trim().to_string(),
                });
            }
        }
    }
    // Every candidate lost → surface the real error, not "no highlights".
    if wins.is_empty() {
        if let Some(e) = fine_err {
            return Err(e);
        }
    }
    Ok(rank(wins, top_n))
}

// ---------------------------------------------------------------------------
// ffmpeg / yt-dlp I/O.
// ---------------------------------------------------------------------------

/// `(t_seconds, RMS_dB)` per 1s window via ffmpeg astats. The `ametadata=print
/// :file=-` filter writes readings to STDOUT (not stderr), one `pts_time:` line
/// followed by a `RMS_level=` line; "-inf" silence lines are skipped.
pub fn loudness_series(path: &str) -> Result<Vec<(f64, f64)>, String> {
    let mut c = Command::new("ffmpeg");
    c.arg("-hide_banner").arg("-i").arg(path).args([
        "-af",
        "aresample=8000,asetnsamples=8000:p=0,astats=metadata=1:reset=1,\
         ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
        "-f",
        "null",
        "-",
    ]);
    commands::no_window(&mut c);
    let out = c
        .output()
        .map_err(|e| format!("ffmpeg not available (is it on PATH?): {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut series = vec![];
    let mut t: Option<f64> = None;
    for line in text.lines() {
        if let Some(i) = line.find("pts_time:") {
            let num: String = line[i + 9..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f64>() {
                t = Some(v);
            }
        } else if let Some(i) = line.find("RMS_level=") {
            let num: String = line[i + 10..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
                .collect();
            if let (Some(tt), Ok(v)) = (t, num.parse::<f64>()) {
                series.push((tt, v));
                t = None;
            }
        }
    }
    Ok(series)
}

/// Last `n` non-empty lines of a process's stderr, joined — enough context to
/// act on a failure instead of a bare exit code.
fn tail_lines(s: &str, n: usize) -> String {
    let v: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    v[v.len().saturating_sub(n)..].join(" | ")
}

/// Run yt-dlp streaming its `[download]  42.3% of …` lines into the job log,
/// throttled to 5% steps. ponytail: percent resets per file (video, then
/// audio, then merge) so the bar can jump back once — harmless, skip fixing.
fn run_download(mut c: Command, id: &str) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    commands::no_window(&mut c);
    let mut child = c
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Drain stderr on a thread (a full pipe deadlocks the child), keeping only
    // the tail for the error message.
    let err_tail = child.stderr.take().map(|e| {
        std::thread::spawn(move || {
            let mut tail = std::collections::VecDeque::with_capacity(5);
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                if tail.len() == 4 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail.into_iter().collect::<Vec<_>>().join(" | ")
        })
    });
    if let Some(out) = child.stdout.take() {
        let mut last = -5i32;
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Some(rest) = line.trim().strip_prefix("[download]") else { continue };
            let rest = rest.trim_start();
            let Some(pct_end) = rest.find('%') else { continue };
            if let Ok(p) = rest[..pct_end].trim().parse::<f64>() {
                let p = p as i32;
                if p >= last + 5 || (p >= 100 && last < 100) {
                    last = p;
                    commands::job_log(id, &format!("Downloading… {p}%"));
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let tail = err_tail.and_then(|t| t.join().ok()).unwrap_or_default();
    if status.success() {
        Ok(())
    } else if tail.is_empty() {
        Err(format!("process failed (exit {:?})", status.code()))
    } else {
        Err(format!("exit {:?} — {tail}", status.code()))
    }
}

/// Run one external stage to completion, keeping stderr's tail for failures.
/// Cancel is not wired for job stages yet — see ROADMAP.
fn run_stage(mut c: Command) -> Result<(), String> {
    commands::no_window(&mut c);
    let out = c
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let tail = tail_lines(&String::from_utf8_lossy(&out.stderr), 3);
        Err(format!("process failed (exit {:?}) — {tail}", out.status.code()))
    }
}

// ---------------------------------------------------------------------------
// Validation (web /api is an untrusted surface).
// ---------------------------------------------------------------------------

fn validate_local(path: &str) -> Result<(), String> {
    // One generic message for both "missing" and "not a file" so the web /api
    // can't be used as a filesystem existence/type oracle. Arbitrary local paths
    // are allowed on purpose — picking your own video is the feature.
    let canon = Path::new(path)
        .canonicalize()
        .map_err(|_| "no such video file".to_string())?;
    if !canon.is_file() {
        return Err("no such video file".to_string());
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), String> {
    if url.chars().any(|c| c.is_control()) {
        return Err("URL contains control characters".into());
    }
    let rest = url
        .strip_prefix("https://")
        .ok_or("only https:// URLs are allowed")?;
    // host = up to first '/', minus any creds/port.
    let host = rest.split('/').next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").to_lowercase();
    const ALLOW: [&str; 6] = [
        "youtube.com",
        "www.youtube.com",
        "youtu.be",
        "twitch.tv",
        "www.twitch.tv",
        "m.twitch.tv",
    ];
    if ALLOW.contains(&host.as_str()) {
        Ok(())
    } else {
        Err(format!("host not allowed: {host} (Twitch/YouTube only)"))
    }
}

// ---------------------------------------------------------------------------
// detect_highlights — fast dual-mode command (local file only).
// ---------------------------------------------------------------------------

pub fn detect_highlights_impl(path: &str, top_n: usize) -> Result<Vec<Highlight>, String> {
    validate_local(path)?;
    let series = loudness_series(path)?;
    Ok(find_highlights(&series, top_n, 6.0, 8.0, 4.0, 3.0))
}

#[tauri::command]
pub async fn detect_highlights(path: String, top_n: Option<usize>) -> Result<Vec<Highlight>, String> {
    let n = top_n.unwrap_or(10);
    tauri::async_runtime::spawn_blocking(move || detect_highlights_impl(&path, n))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// start_sizzle — full pipeline as a background job.
// ---------------------------------------------------------------------------

/// Base dir for generated clips: the user-chosen folder (Highlights → Save to)
/// or the default ~/.claude/cipher-manager/clips/. Job dirs live under it.
fn clips_base(out_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(d) = out_dir.map(str::trim).filter(|d| !d.is_empty()) {
        let p = PathBuf::from(d);
        if !p.is_absolute() {
            return Err("clips folder must be an absolute path".into());
        }
        return Ok(p);
    }
    let root = claude::claude_root().ok_or("~/.claude not found")?;
    Ok(root.join("cipher-manager").join("clips"))
}

fn fetch(id: &str, src: &str, job_dir: &Path) -> Result<PathBuf, String> {
    if src.starts_with("http://") || src.starts_with("https://") {
        validate_url(src)?;
        let target = job_dir.join("source.mp4");
        // A stale source.mp4 (leftover job folder) makes yt-dlp skip the
        // download entirely — we'd silently process the wrong video.
        let _ = std::fs::remove_file(&target);
        let mut c = Command::new("yt-dlp");
        // --newline: one progress line per update so we can stream percent.
        // -N 8: parallel HLS fragment downloads (Twitch VODs are fragment-bound).
        // --fixup never: skip the whole-file TS→MP4 remux after download — every
        // downstream ffmpeg reads MPEG-TS fine and `cut` remuxes per clip, so the
        // rewrap only doubled disk IO (and is the step Bitdefender kills when
        // spawned under the app). --merge-output-format still covers YouTube's
        // separate video+audio merge.
        c.args([
            "-f", "bv*+ba/b", "--merge-output-format", "mp4", "--fixup", "never",
            "-N", "8", "--newline", "-o",
        ])
        .arg(&target)
        .arg(src);
        run_download(c, id).map_err(|e| format!("download failed (yt-dlp on PATH?): {e}"))?;
        if !target.is_file() {
            return Err("download produced no file".into());
        }
        Ok(target)
    } else {
        validate_local(src)?;
        Ok(PathBuf::from(src))
    }
}

fn cut(video: &Path, h: &Highlight, out: &Path, vertical: bool, layout: Option<&FacecamLayout>) -> Result<(), String> {
    // ponytail: -ss before -i is fast but keyframe-inaccurate; the 4s pad absorbs
    // the slack (same as the Python tool). Vertical must re-encode; flat copies.
    let mut c = Command::new("ffmpeg");
    c.arg("-y")
        .arg("-ss")
        .arg(h.start.to_string())
        .arg("-to")
        .arg(h.end.to_string())
        .arg("-i")
        .arg(video);
    match (vertical, layout) {
        (true, Some(l)) => {
            let (w, hh) = probe_dims(&video.to_string_lossy())?;
            c.args(["-filter_complex", &vstack_filter(l, w, hh), "-map", "[v]", "-map", "0:a?", "-c:a", "aac"]);
        }
        (true, None) => {
            c.args(["-vf", "crop=ih*9/16:ih,scale=1080:1920", "-c:a", "aac"]);
        }
        (false, _) => {
            c.args(["-c", "copy"]);
        }
    }
    c.arg(out);
    run_stage(c)
}

fn mashup(clips: &[PathBuf], out: &Path, job_dir: &Path) -> Result<(), String> {
    // All clips in a run share the vertical flag, so codecs are uniform → -c copy.
    let list = job_dir.join("concat.txt");
    let mut body = String::new();
    for c in clips {
        // ffmpeg concat: single-quote the path, escaping any embedded quote.
        let p = c.display().to_string().replace('\'', "'\\''");
        body.push_str(&format!("file '{p}'\n"));
    }
    std::fs::write(&list, body).map_err(|e| e.to_string())?;
    let mut c = Command::new("ffmpeg");
    c.arg("-y")
        .args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-c", "copy"])
        .arg(out);
    let r = run_stage(c);
    let _ = std::fs::remove_file(&list);
    r
}

fn run_sizzle_job(
    id: String,
    src: String,
    top_n: usize,
    vertical: bool,
    mashup_on: bool,
    out_dir: Option<String>,
    ollama_url: Option<String>,
    facecam: Option<FacecamLayout>,
    cloud: Option<CloudVision>,
    stt: Option<SttConfig>,
) {
    let backend = backend_from(ollama_url.as_deref(), cloud);
    let mut ollama: Option<std::process::Child> = None;
    let result = (|| -> Result<usize, String> {
        let job_dir = clips_base(out_dir.as_deref())?.join(&id);
        std::fs::create_dir_all(&job_dir).map_err(|e| e.to_string())?;

        commands::job_log(&id, "Fetching source…");
        let video = fetch(&id, &src, &job_dir)?;
        let vpath = video.to_str().ok_or("bad video path")?.to_string();

        // Fail fast with an actionable message before any expensive work.
        if let VisionBackend::Ollama(base) = &backend {
            ollama = ensure_ollama(&id, base)?;
            check_ollama(base)?;
        }

        commands::job_log(&id, "Scanning loudness…");
        let series = loudness_series(&vpath)?;
        // Loudness is only a candidate source now — a silent video is fine.
        let audio_hl = find_highlights(&series, top_n * CANDIDATE_MULTIPLIER, 6.0, 8.0, 4.0, 3.0);

        let analysis = job_dir.join("analysis");
        std::fs::create_dir_all(&analysis).map_err(|e| e.to_string())?;
        let scanned = visual_scan(&id, &vpath, &analysis, &audio_hl, top_n, &backend, stt.as_ref());
        let _ = std::fs::remove_dir_all(&analysis); // success or failure
        let wins = scanned?;
        if wins.is_empty() {
            return Err("the visual scan produced no usable highlights".into());
        }
        commands::job_log(&id, &format!("Found {} visual highlight(s); cutting…", wins.len()));

        let mut clips = vec![];
        let mut meta = JobMeta {
            source: video.to_string_lossy().to_string(),
            clips: vec![],
            facecam: if vertical { facecam } else { None },
        };
        for (i, w) in wins.iter().enumerate() {
            commands::job_log(
                &id,
                &format!("Cutting clip {}/{} ({:.0}s–{:.0}s)…", i + 1, wins.len(), w.start, w.end),
            );
            let name = format!("clip_{:02}{}.mp4", i, if vertical { "_v" } else { "" });
            let out = job_dir.join(&name);
            let h = Highlight { start: w.start, end: w.end, score: w.score };
            cut(&video, &h, &out, vertical, meta.facecam.as_ref())?;
            meta.clips.push(ClipMeta {
                name,
                start: w.start,
                end: w.end,
                score: w.score,
                audio_score: w.audio,
                reason: w.reason.clone(),
                ai_scored: true,
            });
            clips.push(out);
        }
        write_meta(&job_dir, &meta);
        if mashup_on && clips.len() > 1 {
            commands::job_log(&id, "Building mashup…");
            mashup(&clips, &job_dir.join("mashup.mp4"), &job_dir)?;
        }
        Ok(clips.len())
    })();

    // ponytail: overlapping sizzle jobs could kill Ollama out from under each
    // other; refcount the child if concurrent runs ever become a real thing.
    if let Some(ch) = ollama.take() {
        commands::job_log(&id, "Stopping Ollama…");
        stop_ollama(ch);
    }

    match result {
        Ok(n) => commands::job_done(&id, true, &format!("Done — {n} clip(s) ready.")),
        Err(e) => commands::job_done(&id, false, &format!("Failed: {e}")),
    }
}

pub fn start_sizzle_impl(
    src: String,
    top_n: usize,
    vertical: bool,
    mashup_on: bool,
    out_dir: Option<String>,
    ollama_url: Option<String>,
    facecam: Option<FacecamLayout>,
    cloud: Option<CloudVision>,
    stt: Option<SttConfig>,
) -> Result<String, String> {
    commands::require_acting_mode()?;
    // Validate up front so bad input errors immediately, not just inside the job.
    if src.starts_with("http://") || src.starts_with("https://") {
        validate_url(&src)?;
    } else {
        validate_local(&src)?;
    }
    clips_base(out_dir.as_deref())?; // reject a bad Save-to folder immediately
    let id = commands::job_new("sizzle", "Highlights", None);
    let jid = id.clone();
    std::thread::spawn(move || {
        run_sizzle_job(jid, src, top_n, vertical, mashup_on, out_dir, ollama_url, facecam, cloud, stt)
    });
    Ok(id)
}

#[tauri::command]
pub async fn start_sizzle(
    src: String,
    top_n: Option<usize>,
    vertical: Option<bool>,
    mashup: Option<bool>,
    out_dir: Option<String>,
    ollama_url: Option<String>,
    facecam: Option<FacecamLayout>,
    cloud: Option<CloudVision>,
    stt: Option<SttConfig>,
) -> Result<String, String> {
    start_sizzle_impl(
        src,
        top_n.unwrap_or(8),
        vertical.unwrap_or(false),
        mashup.unwrap_or(false),
        out_dir,
        ollama_url,
        facecam,
        cloud,
        stt,
    )
}

// ---------------------------------------------------------------------------
// list_clips — read a finished job's output folder.
// ---------------------------------------------------------------------------

/// Source video path recorded in a finished job's meta — lets the UI reanalyze
/// the same (already-downloaded) video without fetching it again.
pub fn sizzle_source_impl(job_id: &str, out_dir: Option<&str>) -> Result<String, String> {
    if job_id.is_empty() || !job_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad job id".into());
    }
    let dir = clips_base(out_dir)?.join(job_id);
    let meta = read_meta(&dir);
    if meta.source.is_empty() {
        return Err("this job has no recorded source video — start again from the URL/file".into());
    }
    Ok(meta.source)
}

#[tauri::command]
pub async fn sizzle_source(
    app: tauri::AppHandle,
    job_id: String,
    out_dir: Option<String>,
) -> Result<String, String> {
    let src = sizzle_source_impl(&job_id, out_dir.as_deref())?;
    // The Layout/Trim modals stream this file over the asset protocol; a
    // user-picked local source lives outside the scoped clips dir.
    use tauri::Manager;
    let _ = app.asset_protocol_scope().allow_file(&src);
    Ok(src)
}

pub fn list_clips_impl(job_id: &str, out_dir: Option<&str>) -> Vec<Clip> {
    // job_id is a "job-N" token; refuse anything that could escape the base dir.
    if job_id.is_empty() || !job_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return vec![];
    }
    let Ok(dir) = clips_base(out_dir).map(|b| b.join(job_id)) else {
        return vec![];
    };
    let meta = read_meta(&dir);
    let find = |name: &str| meta.clips.iter().find(|c| c.name == name);
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let is_clip = (name.starts_with("clip_") && name.ends_with(".mp4"))
                || name == "mashup.mp4"
                || (name.starts_with("compilation") && name.ends_with(".mp4"));
            if is_clip {
                let m = find(&name);
                out.push(Clip {
                    vertical: name.contains("_v"),
                    path: e.path().to_string_lossy().to_string(),
                    score: m.map(|c| c.score).unwrap_or(0.0),
                    audio_score: m.map(|c| c.audio_score).unwrap_or(0.0),
                    reason: m.map(|c| c.reason.clone()).unwrap_or_default(),
                    ai_scored: m.map(|c| c.ai_scored).unwrap_or(false),
                    start: m.map(|c| c.start).unwrap_or(0.0),
                    end: m.map(|c| c.end).unwrap_or(0.0),
                    name,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
pub fn list_clips(app: tauri::AppHandle, job_id: String, out_dir: Option<String>) -> Vec<Clip> {
    // The in-app player streams clips over the asset protocol; the default
    // clips dir is scoped in tauri.conf.json, a custom Save-to folder gets
    // allowed at runtime here (list_clips always runs before playback).
    if let Some(d) = out_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        use tauri::Manager;
        let _ = app.asset_protocol_scope().allow_directory(d, true);
    }
    list_clips_impl(&job_id, out_dir.as_deref())
}

fn safe_job(job_id: &str) -> bool {
    !job_id.is_empty() && job_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A plain clip filename inside a job dir — no separators or traversal.
fn safe_clip_name(name: &str) -> bool {
    !name.is_empty()
        && name.ends_with(".mp4")
        && !name.contains(['/', '\\'])
        && !name.contains("..")
}

/// Re-cut one clip from its source at new bounds ("Adjust start & end" — the
/// clip can be trimmed OR extended past the original window). Preserves the
/// clip's orientation, overwrites it in place, and updates the sidecar.
pub fn recut_clip_impl(
    job_id: &str,
    name: &str,
    start: f64,
    end: f64,
    out_dir: Option<&str>,
) -> Result<Clip, String> {
    if !safe_job(job_id) || !safe_clip_name(name) {
        return Err("bad job or clip name".into());
    }
    if !(end > start) || start < 0.0 {
        return Err("end must be after start".into());
    }
    let dir = clips_base(out_dir)?.join(job_id);
    let mut meta = read_meta(&dir);
    if meta.source.is_empty() || !Path::new(&meta.source).is_file() {
        return Err("source video for this job is no longer available".into());
    }
    let out = dir.join(name);
    let vertical = name.contains("_v");
    let h = Highlight { start, end, score: 0.0 };
    cut(
        Path::new(&meta.source),
        &h,
        &out,
        vertical,
        if vertical { meta.facecam.as_ref() } else { None },
    )?;

    if let Some(c) = meta.clips.iter_mut().find(|c| c.name == name) {
        c.start = start;
        c.end = end;
    } else {
        meta.clips.push(ClipMeta {
            name: name.to_string(),
            start,
            end,
            score: 0.0,
            audio_score: 0.0,
            reason: String::new(),
            ai_scored: false,
        });
    }
    write_meta(&dir, &meta);
    let m = meta.clips.iter().find(|c| c.name == name).unwrap();
    Ok(Clip {
        name: name.to_string(),
        path: out.to_string_lossy().to_string(),
        vertical,
        score: m.score,
        audio_score: m.audio_score,
        reason: m.reason.clone(),
        ai_scored: m.ai_scored,
        start,
        end,
    })
}

#[tauri::command]
pub async fn recut_clip(
    job_id: String,
    name: String,
    start: f64,
    end: f64,
    out_dir: Option<String>,
) -> Result<Clip, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recut_clip_impl(&job_id, &name, start, end, out_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Burn animated captions into a copy of one clip (`clip_XX[_v]_cap.mp4`).
/// Transcription goes to the given STT endpoint (WhisperX or OpenAI — the
/// frontend builds the request parts; headers may carry secret refs, which
/// multipart_post resolves). The original clip is untouched.
// --- Candidate-window transcripts (dialog-assisted fine scoring) -----------
// The scoring passes are vision-only, so spoken jokes were invisible; each
// fine-scan candidate gets its audio transcribed and the words fed into the
// prompt. Batch runs BEFORE the fine vision loop so WhisperX and a local
// vision model never fight for VRAM.

/// Caption STT parts + the WhisperX container so the job can boot/stop it.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SttConfig {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub fields: HashMap<String, String>,
    pub file_field: String,
    /// Docker container to boot for the batch ("" = service is not ours to manage).
    #[serde(default)]
    pub container: String,
}

/// Join STT words into a prompt-sized text: ~1500 bytes, cut on a char
/// boundary, and short texts keep their final character.
fn words_to_text(words: &[(f64, f64, String)]) -> String {
    let mut text = words.iter().map(|(_, _, w)| w.as_str()).collect::<Vec<_>>().join(" ");
    if text.len() > 1500 {
        let cut = text
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|&i| i <= 1500)
            .last()
            .unwrap_or(0);
        text.truncate(cut);
    }
    text.trim().to_string()
}

fn transcribe_window(
    video: &str,
    start: f64,
    len: f64,
    analysis: &Path,
    i: usize,
    stt: &SttConfig,
) -> Result<String, String> {
    let wav = analysis.join(format!("cand_{i:02}.wav"));
    let mut c = Command::new("ffmpeg");
    c.arg("-y")
        .args(["-ss", &format!("{start}")])
        .args(["-t", &format!("{len}")])
        .arg("-i")
        .arg(video)
        .args(["-vn", "-ac", "1", "-ar", "16000"])
        .arg(&wav);
    run_stage(c).map_err(|e| format!("audio extract failed: {e}"))?;
    let bytes = std::fs::read(&wav).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wav);
    let (status, body) = commands::multipart_post(
        &stt.url, &stt.headers, &stt.fields, &stt.file_field, "audio.wav", "audio/wav", &bytes, 600,
    )?;
    if status >= 300 {
        let cut = body.char_indices().map(|(i, _)| i).take_while(|&i| i <= 200).last().unwrap_or(0);
        return Err(format!("transcription failed ({status}): {}", &body[..cut]));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "transcription returned no JSON".to_string())?;
    Ok(words_to_text(&stt_words(&v, len)))
}

/// One transcript per candidate ("" = no speech / failed — that window scores
/// vision-only). Boots the WhisperX container when it's ours and stops it
/// after, freeing the GPU before the fine vision loop starts.
fn candidate_dialogs(
    id: &str,
    video: &str,
    cands: &[Candidate],
    analysis: &Path,
    stt: &SttConfig,
) -> Vec<String> {
    let mut started = false;
    if !stt.container.is_empty() {
        match crate::recorder::docker_container_impl(&stt.container, "status") {
            Ok(st) if !st.running => {
                commands::job_log(id, "Starting WhisperX for candidate transcripts…");
                started = crate::recorder::docker_container_impl(&stt.container, "start").is_ok();
            }
            _ => {}
        }
    }
    // Cold container: the model loads for a minute or two, so the first window
    // retries; after one success everything is warm and failures are final.
    let mut warmed = !started;
    let mut out = Vec::with_capacity(cands.len());
    for (i, c) in cands.iter().enumerate() {
        commands::job_log(id, &format!("Transcribing candidate {}/{}…", i + 1, cands.len()));
        let mut tries = 0;
        let text = loop {
            match transcribe_window(video, c.start, (c.end - c.start).max(1.0), analysis, i, stt) {
                Ok(t) => {
                    warmed = true; // any successful response = model is loaded
                    break t;
                }
                Err(_) if !warmed && tries < 12 => {
                    tries += 1;
                    std::thread::sleep(std::time::Duration::from_secs(15));
                }
                Err(e) => {
                    commands::job_log(
                        id,
                        &format!("Transcript for candidate {} failed ({e}) — scoring without dialog", i + 1),
                    );
                    break String::new();
                }
            }
        };
        out.push(text);
    }
    if started {
        let _ = crate::recorder::docker_container_impl(&stt.container, "stop");
        commands::job_log(id, "WhisperX stopped — GPU freed for the fine scan.");
    }
    out
}

pub fn caption_clip_impl(
    job_id: &str,
    name: &str,
    out_dir: Option<&str>,
    stt_url: &str,
    stt_headers: &HashMap<String, String>,
    stt_fields: &HashMap<String, String>,
    file_field: &str,
    style: &str,
) -> Result<Clip, String> {
    if !safe_job(job_id) || !safe_clip_name(name) {
        return Err("bad job or clip name".into());
    }
    if !commands::proxy_allowed(stt_url) {
        return Err("This URL isn't allowed (use https://, or http:// only on localhost).".into());
    }
    let dir = clips_base(out_dir)?.join(job_id);
    let clip = dir.join(name);
    if !clip.is_file() {
        return Err(format!("clip not found: {name}"));
    }

    // 1. Clip audio → mono 16k wav (what both STT services want).
    let wav = dir.join("cap_audio.wav");
    let mut c = Command::new("ffmpeg");
    c.arg("-y").arg("-i").arg(&clip).args(["-vn", "-ac", "1", "-ar", "16000"]).arg(&wav);
    run_stage(c).map_err(|e| format!("audio extract failed: {e}"))?;
    let bytes = std::fs::read(&wav).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wav);

    // 2. Transcribe.
    let (status, body) = commands::multipart_post(
        stt_url, stt_headers, stt_fields, file_field, "audio.wav", "audio/wav", &bytes, 600,
    )?;
    if status >= 300 {
        // Char-boundary-safe ~200-byte snippet (a naive byte slice can panic mid-UTF-8).
        let cut = body.char_indices().map(|(i, _)| i).take_while(|&i| i <= 200).last().unwrap_or(0);
        return Err(format!("transcription failed ({status}): {}", &body[..cut]));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "transcription returned no JSON".to_string())?;
    let mut meta = read_meta(&dir);
    let orig = meta.clips.iter().find(|c| c.name == name).cloned();
    let clip_len = orig.as_ref().map(|c| (c.end - c.start).max(1.0)).unwrap_or(30.0);
    let words = stt_words(&v, clip_len);
    if words.is_empty() {
        return Err("No speech detected in this clip".into());
    }

    // 3–4. ASS → burn. Run ffmpeg from the job dir: the ass= filter arg is a
    // filter-graph string where a Windows drive path would need escaping.
    let vertical = name.contains("_v");
    let subs = dir.join("cap_subs.ass");
    std::fs::write(&subs, build_ass(&words, style, vertical)).map_err(|e| e.to_string())?;
    let out_name = format!("{}_cap.mp4", name.trim_end_matches(".mp4"));
    let mut c = Command::new("ffmpeg");
    c.current_dir(&dir)
        .arg("-y")
        .arg("-i")
        .arg(name)
        .args(["-vf", "ass=cap_subs.ass", "-c:a", "copy"])
        .arg(&out_name);
    let burned = run_stage(c);
    let _ = std::fs::remove_file(&subs);
    if let Err(e) = burned {
        // Don't leave a broken partial _cap.mp4 behind for list_clips to surface.
        let _ = std::fs::remove_file(dir.join(&out_name));
        return Err(format!("caption burn failed: {e}"));
    }

    // 5. Sidecar: carry the original's score/bounds over to the copy.
    if let Some(o) = orig {
        meta.clips.retain(|c| c.name != out_name);
        meta.clips.push(ClipMeta { name: out_name.clone(), ..o });
        write_meta(&dir, &meta);
    }
    let m = meta.clips.iter().find(|c| c.name == out_name);
    Ok(Clip {
        path: dir.join(&out_name).to_string_lossy().to_string(),
        vertical,
        score: m.map(|c| c.score).unwrap_or(0.0),
        audio_score: m.map(|c| c.audio_score).unwrap_or(0.0),
        reason: m.map(|c| c.reason.clone()).unwrap_or_default(),
        ai_scored: m.map(|c| c.ai_scored).unwrap_or(false),
        start: m.map(|c| c.start).unwrap_or(0.0),
        end: m.map(|c| c.end).unwrap_or(0.0),
        name: out_name,
    })
}

#[tauri::command]
pub async fn caption_clip(
    job_id: String,
    name: String,
    out_dir: Option<String>,
    stt_url: String,
    stt_headers: HashMap<String, String>,
    stt_fields: HashMap<String, String>,
    file_field: String,
    style: String,
) -> Result<Clip, String> {
    tauri::async_runtime::spawn_blocking(move || {
        caption_clip_impl(
            &job_id, &name, out_dir.as_deref(), &stt_url, &stt_headers, &stt_fields, &file_field, &style,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stitch selected clips (by filename, in the given order) from one job into a
/// single compilation video. All must share orientation (uniform codecs → copy).
pub fn make_compilation_impl(
    job_id: &str,
    names: &[String],
    out_dir: Option<&str>,
) -> Result<Clip, String> {
    if !safe_job(job_id) {
        return Err("bad job".into());
    }
    if names.len() < 2 {
        return Err("pick at least two clips".into());
    }
    let dir = clips_base(out_dir)?.join(job_id);
    let mut paths = vec![];
    let mut vertical = false;
    for (i, n) in names.iter().enumerate() {
        if !safe_clip_name(n) {
            return Err("bad clip name".into());
        }
        let p = dir.join(n);
        if !p.is_file() {
            return Err(format!("clip not found: {n}"));
        }
        let v = n.contains("_v");
        if i == 0 {
            vertical = v;
        } else if v != vertical {
            return Err("mix of vertical and horizontal clips — compile one orientation at a time".into());
        }
        paths.push(p);
    }
    // Unique output name so repeated compiles don't clobber each other.
    let existing = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("compilation")).count())
        .unwrap_or(0);
    let out_name = format!("compilation_{:02}{}.mp4", existing + 1, if vertical { "_v" } else { "" });
    let out = dir.join(&out_name);
    mashup(&paths, &out, &dir)?;
    Ok(Clip {
        name: out_name,
        path: out.to_string_lossy().to_string(),
        vertical,
        score: 0.0,
        audio_score: 0.0,
        reason: String::new(),
        ai_scored: false,
        start: 0.0,
        end: 0.0,
    })
}

#[tauri::command]
pub async fn make_compilation(
    job_id: String,
    names: Vec<String>,
    out_dir: Option<String>,
) -> Result<Clip, String> {
    tauri::async_runtime::spawn_blocking(move || {
        make_compilation_impl(&job_id, &names, out_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Captions — transcript → ASS subtitles burned into a clip copy.
// ---------------------------------------------------------------------------

/// `(start, end, word)` list from a WhisperX (`segments[].words[]`) or OpenAI
/// verbose_json (`words[]`) response. Wordless segments space their words
/// evenly; a bare `{text}` spaces across the whole clip. Empty = no speech.
fn stt_words(v: &serde_json::Value, clip_len: f64) -> Vec<(f64, f64, String)> {
    let mut out: Vec<(f64, f64, String)> = vec![];
    let push_spaced = |out: &mut Vec<(f64, f64, String)>, text: &str, s: f64, e: f64| {
        let toks: Vec<&str> = text.split_whitespace().collect();
        if toks.is_empty() {
            return;
        }
        let step = (e - s).max(0.2) / toks.len() as f64;
        for (i, t) in toks.iter().enumerate() {
            out.push((s + i as f64 * step, s + (i + 1) as f64 * step, t.to_string()));
        }
    };
    if let Some(words) = v.get("words").and_then(|w| w.as_array()) {
        for w in words {
            let t = w.get("word").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
            if t.is_empty() {
                continue;
            }
            let s = w.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let e = w.get("end").and_then(|x| x.as_f64()).unwrap_or(s + 0.3);
            out.push((s, e, t));
        }
    }
    if out.is_empty() {
        if let Some(segs) = v.get("segments").and_then(|s| s.as_array()) {
            for seg in segs {
                let s = seg.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let e = seg.get("end").and_then(|x| x.as_f64()).unwrap_or(s);
                if let Some(words) = seg.get("words").and_then(|w| w.as_array()) {
                    for w in words {
                        let t = w.get("word").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                        if t.is_empty() {
                            continue;
                        }
                        let ws = w.get("start").and_then(|x| x.as_f64()).unwrap_or(s);
                        let we = w.get("end").and_then(|x| x.as_f64()).unwrap_or(ws + 0.3);
                        out.push((ws, we, t));
                    }
                } else {
                    push_spaced(&mut out, seg.get("text").and_then(|x| x.as_str()).unwrap_or(""), s, e);
                }
            }
        }
    }
    if out.is_empty() {
        push_spaced(&mut out, v.get("text").and_then(|x| x.as_str()).unwrap_or(""), 0.0, clip_len.max(1.0));
    }
    out
}

/// ASS `H:MM:SS.CC` timestamp (centiseconds), clamped at zero.
fn ass_time(t: f64) -> String {
    let cs = (t.max(0.0) * 100.0).round() as u64;
    format!("{}:{:02}:{:02}.{:02}", cs / 360000, cs / 6000 % 60, cs / 100 % 60, cs % 100)
}

/// ASS text can't safely carry override braces or backslashes — strip them.
fn ass_escape(s: &str) -> String {
    s.replace('\\', "").replace('{', "(").replace('}', ")").replace('\n', " ")
}

/// Words grouped into caption lines: break on `max_words` or a >1.2s gap.
fn caption_lines(words: &[(f64, f64, String)], max_words: usize) -> Vec<Vec<(f64, f64, String)>> {
    let mut lines: Vec<Vec<(f64, f64, String)>> = vec![];
    let mut cur: Vec<(f64, f64, String)> = vec![];
    for w in words {
        let brk = cur.len() >= max_words || cur.last().map(|p| w.0 - p.1 > 1.2).unwrap_or(false);
        if brk && !cur.is_empty() {
            lines.push(std::mem::take(&mut cur));
        }
        cur.push(w.clone());
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

/// Full ASS document for one clip. `bold` = one popping word at a time,
/// `karaoke` = line with per-word \k highlight, `minimal` = plain small lines.
fn build_ass(words: &[(f64, f64, String)], style: &str, vertical: bool) -> String {
    let (rx, ry) = if vertical { (1080, 1920) } else { (1920, 1080) };
    let margin = ry / 5; // lower-third-ish, above platform UI chrome
    let size = if vertical { 88 } else { 64 };
    // Fields: Name,Font,Size,Primary,Secondary,Outline,Back,Bold,Italic,Underline,
    // StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,ML,MR,MV,Enc
    let style_line = match style {
        "karaoke" => format!(
            "Style: Cap,Arial Black,{size},&H0000FFFF,&H00FFFFFF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,{margin},1"
        ),
        "minimal" => format!(
            "Style: Cap,Arial,{},&H00FFFFFF,&H000000FF,&H00000000,&H7F000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,{margin},1",
            size * 2 / 3
        ),
        _ => format!(
            "Style: Cap,Arial Black,{size},&H00FFFFFF,&H000000FF,&H00000000,&H7F000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,{margin},1"
        ),
    };
    let mut ev = String::new();
    match style {
        "bold" => {
            // Each word its own event; hold until the next word starts so the
            // screen is never empty mid-sentence (capped at +1.5s on gaps).
            for (i, (s, e, t)) in words.iter().enumerate() {
                let until = words.get(i + 1).map(|n| n.0).unwrap_or(*e).max(*e).min(e + 1.5);
                ev.push_str(&format!(
                    "Dialogue: 0,{},{},Cap,,0,0,0,,{{\\fscx70\\fscy70\\t(0,110,\\fscx100\\fscy100)}}{}\n",
                    ass_time(*s),
                    ass_time(until),
                    ass_escape(t)
                ));
            }
        }
        "karaoke" => {
            for line in caption_lines(words, 4) {
                let (ls, le) = (line[0].0, line.last().unwrap().1);
                let mut text = String::new();
                for (s, e, t) in &line {
                    let cs = ((e - s).max(0.05) * 100.0).round() as u64;
                    text.push_str(&format!("{{\\k{cs}}}{} ", ass_escape(t)));
                }
                ev.push_str(&format!(
                    "Dialogue: 0,{},{},Cap,,0,0,0,,{}\n",
                    ass_time(ls),
                    ass_time(le),
                    text.trim_end()
                ));
            }
        }
        _ => {
            for line in caption_lines(words, 6) {
                let (ls, le) = (line[0].0, line.last().unwrap().1);
                let text: Vec<String> = line.iter().map(|(_, _, t)| ass_escape(t)).collect();
                ev.push_str(&format!(
                    "Dialogue: 0,{},{},Cap,,0,0,0,,{}\n",
                    ass_time(ls),
                    ass_time(le),
                    text.join(" ")
                ));
            }
        }
    }
    format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {rx}\nPlayResY: {ry}\nWrapStyle: 0\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n{style_line}\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n{ev}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_highlights_selfcheck() {
        // Quiet baseline (-30) with a loud burst at t=10..13 (-8).
        let mut series: Vec<(f64, f64)> = (0..240).map(|i| (i as f64 * 0.1, -30.0)).collect();
        for (i, s) in series.iter_mut().enumerate() {
            if (100..131).contains(&i) {
                *s = (i as f64 * 0.1, -8.0);
            }
        }
        let hl = find_highlights(&series, 3, 6.0, 8.0, 4.0, 3.0);
        assert!(!hl.is_empty(), "should find the burst");
        assert!(hl[0].start <= 10.0 && hl[0].end >= 13.0, "covers burst: {:?}", hl[0]);
        assert!(hl[0].score > 15.0, "burst ~22 dB over baseline: {}", hl[0].score);

        // A flat series has no highlights.
        let flat: Vec<(f64, f64)> = (0..100).map(|i| (i as f64 * 0.1, -30.0)).collect();
        assert!(find_highlights(&flat, 10, 6.0, 8.0, 4.0, 3.0).is_empty());
    }

    #[test]
    fn model_ids_and_scores_validated() {
        assert_eq!(id_index("block-0004", "block-", 10), Some(4));
        assert_eq!(id_index("block-0004", "block-", 4), None); // out of range
        assert_eq!(id_index("candidate-03", "candidate-", 5), Some(3));
        assert_eq!(id_index("clip-01", "block-", 10), None); // unknown prefix
        assert_eq!(id_index("block-xyz", "block-", 10), None); // malformed
        assert!(valid_score(0.0) && valid_score(100.0));
        assert!(!valid_score(-1.0) && !valid_score(100.5) && !valid_score(f64::NAN));
    }

    #[test]
    fn refine_window_maps_and_clamps_frames() {
        // 60s window at 120s, 12 frames → 5s step, ±4s pad.
        let (s, e) = refine_window(120.0, 60.0, 2, 4, 12, 600.0).unwrap();
        assert_eq!((s, e), (126.0, 149.0));
        // End clamps to the source duration.
        let (_, e) = refine_window(120.0, 60.0, 0, 11, 12, 150.0).unwrap();
        assert_eq!(e, 150.0);
        // Start clamps to 0.
        let (s, _) = refine_window(0.0, 60.0, 0, 3, 12, 600.0).unwrap();
        assert_eq!(s, 0.0);
        // A one-frame pick still yields a valid, long-enough clip.
        let (s, e) = refine_window(0.0, 60.0, 6, 6, 12, 600.0).unwrap();
        assert!(e - s >= MIN_CLIP_LEN);
        // Inverted or out-of-range picks are rejected.
        assert!(refine_window(0.0, 60.0, 5, 2, 12, 600.0).is_none());
        assert!(refine_window(0.0, 60.0, -1, 2, 12, 600.0).is_none());
        assert!(refine_window(0.0, 60.0, 0, 12, 12, 600.0).is_none());
    }

    #[test]
    fn overlapping_visual_and_audio_candidates_merge_once() {
        let merged = merge_windows(vec![
            Candidate { start: 60.0, end: 120.0, audio: 0.0 },  // visual block
            Candidate { start: 110.0, end: 121.0, audio: 9.5 }, // overlapping audio window
            Candidate { start: 300.0, end: 310.0, audio: 7.0 },
        ]);
        assert_eq!(merged.len(), 2);
        assert_eq!((merged[0].start, merged[0].end, merged[0].audio), (60.0, 121.0, 9.5));
        assert_eq!(merged[1], Candidate { start: 300.0, end: 310.0, audio: 7.0 });
    }

    #[test]
    fn ai_score_sorts_and_loudness_breaks_ties() {
        let w = |start: f64, score: f64, audio: f64| ScoredWindow {
            start,
            end: start + 10.0,
            score,
            audio,
            reason: String::new(),
        };
        let ranked = rank(vec![w(0.0, 80.0, 2.0), w(20.0, 91.0, 0.0), w(40.0, 80.0, 9.0)], 2);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].score, 91.0);
        assert_eq!(ranked[1].start, 40.0); // 80-point tie → louder wins
        // Overlapping windows keep only the best-scored one.
        let ranked = rank(vec![w(0.0, 90.0, 0.0), w(5.0, 60.0, 0.0)], 5);
        assert_eq!(ranked.len(), 1);
    }

    /// End-to-end smoke test of the visual pipeline against a real local video
    /// and a live Ollama with qwen3-vl:30b. Run with:
    /// `SIZZLE_TEST_VIDEO=path\to\video.mp4 cargo test -- --ignored --nocapture real_visual_scan`
    #[test]
    #[ignore = "needs Ollama + qwen3-vl:30b + SIZZLE_TEST_VIDEO — run explicitly"]
    fn real_visual_scan() {
        let video = std::env::var("SIZZLE_TEST_VIDEO").expect("set SIZZLE_TEST_VIDEO");
        check_ollama(DEFAULT_OLLAMA).expect("Ollama preflight");
        let duration = probe_duration(&video).expect("duration");
        let series = loudness_series(&video).expect("loudness");
        let top_n = 3;
        let audio_hl = find_highlights(&series, top_n * CANDIDATE_MULTIPLIER, 6.0, 8.0, 4.0, 3.0);
        eprintln!("\n=== real visual scan ({duration:.0}s) ===");
        eprintln!("audio candidates: {audio_hl:?}");
        let analysis = std::env::temp_dir().join("sizzle-smoke-analysis");
        std::fs::create_dir_all(&analysis).unwrap();
        let backend = VisionBackend::Ollama(DEFAULT_OLLAMA.into());
        let wins = visual_scan("smoke", &video, &analysis, &audio_hl, top_n, &backend, None);
        let _ = std::fs::remove_dir_all(&analysis);
        let wins = wins.expect("visual scan");
        assert!(!wins.is_empty(), "no windows survived");
        for w in &wins {
            eprintln!(
                "{:>7.1}s–{:<7.1}s  AI {:>3.0}  audio {:>5.1} dB  {}",
                w.start, w.end, w.score, w.audio, w.reason
            );
            assert!(w.start < w.end, "inverted window: {w:?}");
            assert!(w.end <= duration, "window past duration: {w:?}");
        }
    }

    #[test]
    fn stderr_tail_is_compact() {
        assert_eq!(tail_lines("a\n\nb\nc\nd\n", 3), "b | c | d");
        assert_eq!(tail_lines("only", 3), "only");
        assert_eq!(tail_lines("", 3), "");
    }

    #[test]
    fn custom_clips_dir_validated() {
        let _guard = crate::commands::state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _profile = crate::commands::TestProfile::new("cm-clips-test", false);
        assert!(clips_base(Some("relative/dir")).is_err());
        let tmp = std::env::temp_dir();
        assert_eq!(clips_base(Some(tmp.to_str().unwrap())).unwrap(), tmp);
        // Blank/whitespace falls back to the default base.
        assert!(clips_base(Some("  ")).unwrap().ends_with("clips"));
    }

    #[test]
    fn scan_cache_round_trip_and_invalidation() {
        let dir = std::env::temp_dir().join("cm-scan-cache-test");
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("v.mp4");
        std::fs::write(&video, b"12345").unwrap();
        let v = video.to_str().unwrap();
        let ollama = VisionBackend::Ollama(DEFAULT_OLLAMA.into());
        let scores = vec![(0usize, 55.0), (3, 80.0)];
        write_scan_cache(v, &scores, &ollama);
        assert_eq!(read_scan_cache(v, &ollama), Some(scores.clone()));
        // Switching to a cloud backend invalidates the cache (params mismatch).
        let cloud = VisionBackend::Cloud(CloudVision {
            kind: "openai".into(),
            url: "https://x/v1/chat/completions".into(),
            model: "gpt-4o-mini".into(),
            headers: Default::default(),
        });
        assert_eq!(read_scan_cache(v, &cloud), None);
        // Changed video (different size) must invalidate the cache.
        std::fs::write(&video, b"123456").unwrap();
        assert_eq!(read_scan_cache(v, &ollama), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rapid-fires 8 coarse batches like a real scan to expose rate limits.
    /// `SIZZLE_TEST_VIDEO=<video> cargo test -- --ignored --nocapture real_gemini_burst`
    #[test]
    #[ignore = "needs the gemini key + network + SIZZLE_TEST_VIDEO — run explicitly"]
    fn real_gemini_burst() {
        let video = std::env::var("SIZZLE_TEST_VIDEO").expect("set SIZZLE_TEST_VIDEO");
        let tmp = std::env::temp_dir().join("gemini-burst-probe");
        std::fs::create_dir_all(&tmp).unwrap();
        let p = tmp.join("sheet.jpg");
        extract_sheet(&video, &p, 300.0, COARSE_BLOCK_SECS, COARSE_FRAMES_PER_BLOCK, 3).expect("sheet");
        let b64 = commands::base64_encode(&std::fs::read(&p).unwrap());
        let images: Vec<String> = (0..COARSE_BLOCKS_PER_REQUEST).map(|_| b64.clone()).collect();
        let cv = CloudVision {
            kind: "openai".into(),
            url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".into(),
            model: "gemini-flash-latest".into(),
            headers: [(
                "Authorization".to_string(),
                "Bearer {{secret:gemini-api-key}}".to_string(),
            )]
            .into(),
        };
        // Raw requests (no vision_chat retry) so every status is visible.
        let prompt = format!("Score each of the 4 attached contact sheets 0-100.\n{RUBRIC}\nReturn JSON.");
        let body = openai_body(&cv.model, &prompt, &images);
        let mut headers = cv.headers.clone();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        for i in 0..8 {
            let t0 = std::time::Instant::now();
            match commands::http_proxy(cv.url.clone(), "POST".into(), headers.clone(), body.to_string()) {
                Ok(r) => {
                    let snippet: String = r.body.chars().take(200).collect::<String>().replace('\n', " ");
                    eprintln!("req {i}: HTTP {} in {:.1}s — {snippet}", r.status, t0.elapsed().as_secs_f32());
                }
                Err(e) => eprintln!("req {i}: transport error: {e}"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Replays coarse-scan batch 1 (4 real contact sheets) against Gemini —
    /// set SIZZLE_TEST_VIDEO to the source.mp4. Run with:
    /// `cargo test -- --ignored --nocapture real_gemini_coarse`
    #[test]
    #[ignore = "needs the gemini key + network + SIZZLE_TEST_VIDEO — run explicitly"]
    fn real_gemini_coarse() {
        let video = std::env::var("SIZZLE_TEST_VIDEO").expect("set SIZZLE_TEST_VIDEO");
        let tmp = std::env::temp_dir().join("gemini-coarse-probe");
        std::fs::create_dir_all(&tmp).unwrap();
        let mut images = vec![];
        let mut lines = String::new();
        for (n, b) in (0..COARSE_BLOCKS_PER_REQUEST).enumerate() {
            let start = b as f64 * COARSE_BLOCK_SECS;
            let p = tmp.join(format!("block_{b:04}.jpg"));
            extract_sheet(&video, &p, start, COARSE_BLOCK_SECS, COARSE_FRAMES_PER_BLOCK, 3)
                .expect("sheet");
            let bytes = std::fs::read(&p).unwrap();
            eprintln!("sheet {b}: {} KB", bytes.len() / 1024);
            images.push(commands::base64_encode(&bytes));
            lines.push_str(&format!(
                "Image {}: block \"block-{b:04}\" covering {start:.0}s–{:.0}s, one frame every {:.1}s starting at {start:.0}s.\n",
                n + 1,
                start + COARSE_BLOCK_SECS,
                COARSE_BLOCK_SECS / COARSE_FRAMES_PER_BLOCK as f64,
            ));
        }
        let prompt = format!(
            "You rate one-minute blocks of a video for how likely they contain a great short clip.\n\
             Each attached image is a contact sheet of {COARSE_FRAMES_PER_BLOCK} frames in chronological \
             reading order (left to right, top to bottom).\n{lines}{RUBRIC}\n\
             Return JSON with one entry per block using the exact block ids given."
        );
        let cv = CloudVision {
            kind: "openai".into(),
            url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".into(),
            model: "gemini-flash-latest".into(),
            headers: [(
                "Authorization".to_string(),
                "Bearer {{secret:gemini-api-key}}".to_string(),
            )]
            .into(),
        };
        let r = vision_chat(&VisionBackend::Cloud(cv), &prompt, &images, coarse_schema());
        let _ = std::fs::remove_dir_all(&tmp);
        match r {
            Ok(s) => {
                eprintln!("RAW OK ({} chars): {}", s.len(), s.chars().take(800).collect::<String>());
                match serde_json::from_str::<CoarseResp>(&s) {
                    Ok(c) => eprintln!("PARSED: {} blocks", c.blocks.len()),
                    Err(e) => eprintln!("CALLER PARSE FAILED: {e}"),
                }
            }
            Err(e) => eprintln!("ERROR: {e}"),
        }
    }

    /// Lists the models the stored Gemini key can use. Run with:
    /// `cargo test -- --ignored --nocapture real_gemini_models`
    #[test]
    #[ignore = "needs the gemini key + network — run explicitly"]
    fn real_gemini_models() {
        let mut headers = std::collections::HashMap::new();
        headers.insert(
            "Authorization".to_string(),
            "Bearer {{secret:gemini-api-key}}".to_string(),
        );
        let r = commands::http_proxy(
            "https://generativelanguage.googleapis.com/v1beta/openai/models".into(),
            "GET".into(),
            headers,
            String::new(),
        )
        .expect("request");
        eprintln!("HTTP {}", r.status);
        eprintln!("{}", r.body.chars().take(4000).collect::<String>());
    }

    /// Live probe against the real Gemini endpoint with the stored key —
    /// prints the full error body on failure. Run with:
    /// `cargo test -- --ignored --nocapture real_gemini_vision`
    #[test]
    #[ignore = "needs the gemini key + network — run explicitly"]
    fn real_gemini_vision() {
        // 1x1 red JPEG.
        let px = commands::base64_encode(&[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
            0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06,
            0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D,
            0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
            0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28,
            0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
            0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01,
            0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
            0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
            0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10,
            0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00,
            0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
            0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42,
            0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16,
            0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37,
            0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55,
            0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73,
            0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
            0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
            0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA,
            0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6,
            0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA,
            0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDA, 0x00, 0x08,
            0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFB, 0xD0, 0xFF, 0xD9,
        ]);
        let cv = CloudVision {
            kind: "openai".into(),
            url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".into(),
            model: "gemini-flash-latest".into(),
            headers: [(
                "Authorization".to_string(),
                "Bearer {{secret:gemini-api-key}}".to_string(),
            )]
            .into(),
        };
        let r = vision_chat(
            &VisionBackend::Cloud(cv),
            "What color is this image? Score it 0-100 for redness.",
            &[px],
            serde_json::json!({"type":"object","properties":{"score":{"type":"number"}},"required":["score"]}),
        );
        match r {
            Ok(s) => eprintln!("OK: {s}"),
            Err(e) => eprintln!("ERROR: {e}"),
        }
    }

    #[test]
    fn extract_json_is_lenient() {
        assert_eq!(extract_json(r#"{"a":1}"#), r#"{"a":1}"#);
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(extract_json("Sure! {\"a\":{\"b\":2}} hope that helps"), "{\"a\":{\"b\":2}}");
        assert_eq!(extract_json("no json here"), "no json here");
    }

    #[test]
    fn cloud_request_bodies_have_the_right_shape() {
        let imgs = vec!["QUJD".to_string()];
        let o = openai_body("gpt-4o-mini", "score this", &imgs);
        assert_eq!(o["model"], "gpt-4o-mini");
        assert_eq!(o["temperature"], 0);
        assert_eq!(o["messages"][0]["content"][0]["type"], "text");
        assert_eq!(
            o["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/jpeg;base64,QUJD"
        );
        let a = anthropic_body("claude-haiku-4-5-20251001", "score this", &imgs);
        assert_eq!(a["max_tokens"], 4000);
        assert_eq!(a["messages"][0]["content"][0]["source"]["data"], "QUJD");
        assert_eq!(a["messages"][0]["content"][1]["type"], "text");
    }

    #[test]
    fn backend_id_distinguishes_backends() {
        let ol = VisionBackend::Ollama("http://127.0.0.1:11434".into());
        let cl = VisionBackend::Cloud(CloudVision {
            kind: "openai".into(),
            url: "https://x/v1/chat/completions".into(),
            model: "gpt-4o-mini".into(),
            headers: Default::default(),
        });
        assert_eq!(backend_id(&ol), format!("ollama:{MODEL}"));
        assert_eq!(backend_id(&cl), "cloud:https://x/v1/chat/completions#gpt-4o-mini");
        assert_ne!(scan_params(&ol), scan_params(&cl)); // cache invalidates on switch
    }

    #[test]
    fn old_meta_without_new_fields_still_loads() {
        let old = r#"{"source":"a.mp4","clips":[{"name":"clip_00.mp4","start":1.0,"end":9.0,"score":21.5}]}"#;
        let m: JobMeta = serde_json::from_str(old).unwrap();
        let c = &m.clips[0];
        assert_eq!(c.score, 21.5); // old dB score kept as-is
        assert!(!c.ai_scored);
        assert_eq!(c.audio_score, 0.0);
        assert!(c.reason.is_empty());
    }

    #[test]
    fn vstack_filter_denormalizes_and_clamps() {
        let l = FacecamLayout {
            cam: CamBox { x: 0.7, y: 0.0, w: 0.3, h: 0.3 },
            game: CamBox { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
        };
        let f = vstack_filter(&l, 1920, 1080);
        assert!(f.contains("crop=576:324:1344:0"), "cam crop: {f}");
        assert!(f.contains("crop=1536:864:192:108"), "game crop: {f}");
        assert!(f.contains("scale=1080:640") && f.contains("scale=1080:1280") && f.contains("vstack"));
        // A box hanging off the right edge gets clamped back inside the frame.
        let l2 = FacecamLayout {
            cam: CamBox { x: 0.9, y: 0.9, w: 0.3, h: 0.3 },
            game: CamBox { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
        };
        let f2 = vstack_filter(&l2, 1920, 1080);
        assert!(f2.contains("crop=576:324:1344:756"), "clamped: {f2}");
    }

    #[test]
    fn ass_time_formats_centiseconds() {
        assert_eq!(ass_time(0.0), "0:00:00.00");
        assert_eq!(ass_time(61.275), "0:01:01.28"); // rounds to nearest cs
        assert_eq!(ass_time(-1.0), "0:00:00.00");   // clamped
    }

    #[test]
    fn words_to_text_joins_and_truncates_on_char_boundary() {
        let w = |s: &str| (0.0, 1.0, s.to_string());
        assert_eq!(words_to_text(&[w("hey"), w("that's"), w("wild")]), "hey that's wild");
        // short text keeps its final character
        assert_eq!(words_to_text(&[w("café")]), "café");
        // long text truncates without panicking mid-UTF-8
        let long: Vec<_> = (0..600).map(|_| w("héé")).collect();
        let t = words_to_text(&long);
        assert!(t.len() <= 1500);
        assert!(t.chars().count() > 0);
    }

    #[test]
    fn stt_words_parses_whisperx_segments_with_words() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"segments":[{"start":1.0,"end":2.0,"text":"hi there",
                 "words":[{"word":"hi","start":1.0,"end":1.4},{"word":"there","start":1.5,"end":2.0}]}]}"#,
        )
        .unwrap();
        let w = stt_words(&v, 30.0);
        assert_eq!(w.len(), 2);
        assert_eq!(w[1], (1.5, 2.0, "there".to_string()));
    }

    #[test]
    fn stt_words_spaces_wordless_segments_evenly() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"segments":[{"start":0.0,"end":2.0,"text":"one two"}]}"#).unwrap();
        let w = stt_words(&v, 30.0);
        assert_eq!(w.len(), 2);
        assert!((w[0].1 - 1.0).abs() < 1e-9 && (w[1].0 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn build_ass_escapes_and_styles() {
        let words = vec![(0.0, 0.5, "hel{lo}".to_string()), (0.5, 1.0, r"a\b".to_string())];
        let a = build_ass(&words, "bold", true);
        assert!(a.contains("PlayResX: 1080") && a.contains("PlayResY: 1920"));
        assert!(a.contains("hel(lo)") && a.contains("ab"), "braces/backslashes stripped: {a}");
        assert_eq!(a.matches("Dialogue:").count(), 2, "one event per word in bold");
        let k = build_ass(&words, "karaoke", false);
        assert!(k.contains(r"{\k") && k.contains("PlayResX: 1920"));
        let m = build_ass(&words, "minimal", false);
        assert_eq!(m.matches("Dialogue:").count(), 1, "minimal groups words into one line");
    }
}
