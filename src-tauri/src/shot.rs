//! Screenshots — capture the whole desktop, one window, or a dragged region to
//! PNG *and* the clipboard in a single pass, then browse what's been taken.
//! Windows-first (PowerShell + System.Drawing/WinForms), same shape as
//! screenrec.rs. Desktop-only: no serve.rs arms.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::Manager;

use crate::commands;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub name: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// Last-write time, millis since the Unix epoch.
    pub taken_at: i64,
    pub bytes: u64,
    /// base64 JPEG preview (~320px wide); None when the PNG couldn't be
    /// decoded. Only `list_screenshots` fills this in.
    pub thumb: Option<String>,
}

/// Capture + clipboard, all three modes plus a re-copy of an existing file.
/// `$Path` is the output PNG for captures and the input file for `copy`.
/// Exit codes: 0 ok, 2 = the region drag was cancelled, anything else = error.
///
/// The path and window title arrive base64-encoded. PowerShell's -File parser
/// reads a bare leading "-" as the start of a parameter name, so a window
/// titled "- Untitled" (or any path starting with a dash) would otherwise blow
/// up argument binding; base64 can only ever produce [A-Za-z0-9+/=].
const SHOT_PS: &str = r#"
param([string]$Mode, [string]$B64Path, [string]$B64Title = "")
function ConvertFrom-B64($s) {
  if ($s) { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) } else { "" }
}
$Path = ConvertFrom-B64 $B64Path
$Title = ConvertFrom-B64 $B64Title
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct ShRect { public int Left, Top, Right, Bottom; }
public class ShWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out ShRect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
# Must run before anything reads screen metrics: an unaware process gets
# virtualised coordinates, so VirtualScreen under-reports and CopyFromScreen
# hands back an upscaled, blurry capture on any display above 100%.
[void][ShWin]::SetProcessDPIAware()

function Copy-ToClipboard($img) {
  # copy=$true -> OleFlushClipboard, so the bitmap outlives this process.
  # Clipboard::SetImage passes copy=$false and the clipboard goes empty the
  # instant PowerShell exits.
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetImage($img)
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
}

function Get-VirtualScreen($b) {
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  return $bmp
}

if ($Mode -eq 'copy') {
  # Through a MemoryStream, not Image.FromFile: FromFile holds a lock that
  # would block deleting the screenshot straight after copying it.
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,$bytes)))
  Copy-ToClipboard $img
  Write-Output ("{0}x{1}" -f $img.Width, $img.Height)
  exit 0
}

$shot = $null

if ($Mode -eq 'screen') {
  $shot = Get-VirtualScreen ([System.Windows.Forms.SystemInformation]::VirtualScreen)
}
elseif ($Mode -eq 'window') {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
  if (-not $p) { [Console]::Error.WriteLine("that window is gone"); exit 1 }
  $h = $p.MainWindowHandle
  if ([ShWin]::IsIconic($h)) { [Console]::Error.WriteLine("that window is minimised"); exit 1 }
  $r = New-Object ShRect
  if (-not [ShWin]::GetWindowRect($h, [ref]$r)) { [Console]::Error.WriteLine("couldn't measure that window"); exit 1 }
  $w = $r.Right - $r.Left
  $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { [Console]::Error.WriteLine("that window has no size"); exit 1 }
  $shot = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($shot)
  $hdc = $g.GetHdc()
  # PW_RENDERFULLCONTENT (2) asks the app to redraw itself, so GPU-composited
  # windows (Chrome, WebView2, Teams) come out as content rather than black,
  # and it keeps working while the window is occluded.
  $ok = [ShWin]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  if (-not $ok) { [Console]::Error.WriteLine("Windows refused to render that window"); exit 1 }
}
elseif ($Mode -eq 'region') {
  # No screenshot is taken until the drag ends. The earlier design grabbed the
  # whole virtual desktop up front and built a second dimmed copy of it to use
  # as the form's BackgroundImage: on a 7680x2160 desktop that measured 204ms
  # and 132MB before the overlay could even appear, which is what read as the
  # screen "scanning" twice.
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $script:form = New-Object System.Windows.Forms.Form
  $script:form.FormBorderStyle = 'None'
  $script:form.StartPosition = 'Manual'
  $script:form.Bounds = $vs
  $script:form.TopMost = $true
  $script:form.KeyPreview = $true
  $script:form.BackColor = [System.Drawing.Color]::Black
  $script:form.Opacity = 0.35
  $script:form.Cursor = [System.Windows.Forms.Cursors]::Cross

  # The selection box is a child control laid out in the form's CLIENT
  # coordinates, not a ControlPaint.DrawReversibleFrame in screen space. On a
  # desktop whose origin is negative (a second monitor to the left of the
  # primary puts VirtualScreen.Left at -3840 here) the screen-space XOR is
  # what drew the band onto the wrong display. Disabled so it never steals
  # the drag from the form underneath it.
  $script:sel = New-Object System.Windows.Forms.Panel
  $script:sel.BackColor = [System.Drawing.Color]::White
  $script:sel.BorderStyle = 'FixedSingle'
  $script:sel.Enabled = $false
  $script:sel.Visible = $false
  $script:form.Controls.Add($script:sel)

  $script:dragging = $false
  $script:originC = New-Object System.Drawing.Point(0, 0)
  $script:pick = [System.Drawing.Rectangle]::Empty

  # Client-space rectangle spanned by the drag so far.
  $script:boxOf = {
    param($p)
    New-Object System.Drawing.Rectangle(
      [Math]::Min($script:originC.X, $p.X), [Math]::Min($script:originC.Y, $p.Y),
      [Math]::Abs($p.X - $script:originC.X), [Math]::Abs($p.Y - $script:originC.Y))
  }

  $script:form.Add_Shown({ param($s, $e) $s.Activate() })
  $script:form.Add_MouseDown({
    param($s, $e)
    $script:dragging = $true
    $script:originC = $e.Location
    $script:sel.Bounds = New-Object System.Drawing.Rectangle($e.X, $e.Y, 0, 0)
    $script:sel.Visible = $true
  })
  $script:form.Add_MouseMove({
    param($s, $e)
    if ($script:dragging) { $script:sel.Bounds = (& $script:boxOf $e.Location) }
  })
  $script:form.Add_MouseUp({
    param($s, $e)
    if ($script:dragging) {
      $b = & $script:boxOf $e.Location
      # Convert once, at the end: client -> screen is the mapping that was
      # verified correct across both monitors.
      $tl = $script:form.PointToScreen((New-Object System.Drawing.Point($b.X, $b.Y)))
      $script:pick = New-Object System.Drawing.Rectangle($tl.X, $tl.Y, $b.Width, $b.Height)
    }
    $script:form.Close()
  })
  $script:form.Add_KeyDown({
    param($s, $e)
    if ($e.KeyCode -eq 'Escape') { $script:pick = [System.Drawing.Rectangle]::Empty; $script:form.Close() }
  })
  [void]$script:form.ShowDialog()
  $script:form.Dispose()
  # Escape, or a click without a drag, means "never mind".
  if ($script:pick.Width -lt 2 -or $script:pick.Height -lt 2) { exit 2 }
  # Let the desktop repaint now the dimming overlay is gone, then grab only
  # the chosen rectangle straight from the screen at its real coordinates.
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 150
  $shot = New-Object System.Drawing.Bitmap($script:pick.Width, $script:pick.Height)
  $rg = [System.Drawing.Graphics]::FromImage($shot)
  $rg.CopyFromScreen($script:pick.X, $script:pick.Y, 0, 0, $shot.Size)
  $rg.Dispose()
}
else { [Console]::Error.WriteLine("unknown capture mode"); exit 1 }

$shot.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
Copy-ToClipboard $shot
Write-Output ("{0}x{1}" -f $shot.Width, $shot.Height)
"#;

/// One pass over the folder: metadata + a base64 JPEG thumb per PNG, so a
/// gallery of N shots costs one PowerShell spawn instead of N.
const LIST_SHOTS_PS: &str = r#"
param([string]$Dir)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$rows = @(Get-ChildItem -LiteralPath $Dir -File -Filter *.png -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 300 | ForEach-Object {
  $w = 0; $h = 0; $thumb = $null
  try {
    # MemoryStream, not Image.FromFile - FromFile locks the file and would
    # block deleting a screenshot the gallery just listed.
    $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream(,[System.IO.File]::ReadAllBytes($_.FullName))))
    $w = $img.Width
    $h = $img.Height
    $tw = 320
    $th = [Math]::Max(1, [int]($h * $tw / $w))
    $small = New-Object System.Drawing.Bitmap($img, $tw, $th)
    $ms = New-Object System.IO.MemoryStream
    $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $thumb = [Convert]::ToBase64String($ms.ToArray())
    $small.Dispose()
    $ms.Dispose()
    $img.Dispose()
  } catch {}
  [pscustomobject]@{
    name = $_.Name
    width = $w
    height = $h
    takenAt = [int64]($_.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds
    bytes = $_.Length
    thumb = $thumb
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
"#;

/// Where screenshots live. Empty setting → ~/.claude/cipher-manager/screenshots
/// (same convention as clipsDir). Created on demand.
fn resolve_dir(dir: &str) -> Result<PathBuf, String> {
    let d = dir.trim();
    let p = if d.is_empty() {
        commands::app_state_dir()?.join("screenshots")
    } else {
        PathBuf::from(d)
    };
    std::fs::create_dir_all(&p).map_err(|e| format!("couldn't open the screenshots folder: {e}"))?;
    Ok(p)
}

/// Reject anything that isn't a plain file name — the frontend only ever names
/// a file inside the gallery folder, never a path. Same guard shape as
/// read_vault_file; the canonicalize check below is the backstop.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.chars().any(char::is_control)
    {
        return Err("Bad screenshot name".into());
    }
    Ok(())
}

/// Resolve `name` inside `dir`, refusing anything that escapes it.
fn shot_path(dir: &str, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    let root = resolve_dir(dir)?
        .canonicalize()
        .map_err(|e| format!("couldn't open the screenshots folder: {e}"))?;
    let file = root
        .join(name)
        .canonicalize()
        .map_err(|_| "Screenshot not found".to_string())?;
    if !file.starts_with(&root) {
        return Err("Screenshot is outside the screenshots folder".into());
    }
    Ok(file)
}

/// First non-empty stderr line, which is where our own `exit 1` messages land.
fn ps_error(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
        .unwrap_or_else(|| "screen capture failed".into())
}

/// "1920x1080" from the script's single stdout line.
fn parse_size(out: &str) -> (u32, u32) {
    let mut it = out.trim().split('x');
    let w = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    let h = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    (w, h)
}

/// Run SHOT_PS. `Ok(None)` = the user cancelled the region drag.
fn run_shot_ps(mode: &str, path: &str, title: &str) -> Result<Option<String>, String> {
    // The C# DllImport block needs double quotes, which don't survive -Command
    // quoting through CreateProcess — run from a temp .ps1 instead.
    let script = std::env::temp_dir().join("cipher-manager-shot.ps1");
    std::fs::write(&script, SHOT_PS).map_err(|e| format!("couldn't write capture script: {e}"))?;
    // -Sta is required: the clipboard and WinForms both refuse to work from a
    // multi-threaded apartment.
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-File"])
        .arg(&script)
        .args(["-Mode", mode, "-B64Path", &commands::base64_encode(path.as_bytes())]);
    // Omitted rather than passed empty: only window mode has a title.
    if !title.is_empty() {
        c.args(["-B64Title", &commands::base64_encode(title.as_bytes())]);
    }
    commands::no_window(&mut c);
    let out = c.output().map_err(|e| format!("couldn't run screen capture: {e}"))?;
    match out.status.code() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_string())),
        Some(2) => Ok(None),
        _ => Err(ps_error(&out.stderr)),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// First free `shot-<stamp>[-n].png` — two captures inside one second would
/// otherwise silently overwrite each other.
fn next_free(root: &PathBuf) -> (String, PathBuf) {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    for n in 0..1000 {
        let name = if n == 0 {
            format!("shot-{stamp}.png")
        } else {
            format!("shot-{stamp}-{n}.png")
        };
        let p = root.join(&name);
        if !p.exists() {
            return (name, p);
        }
    }
    let name = format!("shot-{stamp}-{}.png", now_ms());
    let p = root.join(&name);
    (name, p)
}

fn capture_impl(mode: &str, dir: &str, title: Option<&str>) -> Result<Option<Shot>, String> {
    if !matches!(mode, "screen" | "window" | "region") {
        return Err("Unknown capture mode".into());
    }
    let root = resolve_dir(dir)?;
    let (name, path) = next_free(&root);
    let Some(out) = run_shot_ps(mode, &path.to_string_lossy(), title.unwrap_or(""))? else {
        return Ok(None);
    };
    let (width, height) = parse_size(&out);
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        return Err("the capture produced an empty file".into());
    }
    Ok(Some(Shot {
        name,
        path: path.to_string_lossy().to_string(),
        width,
        height,
        taken_at: now_ms(),
        bytes,
        thumb: None,
    }))
}

/// Capture to PNG + clipboard. `title` is only read in `window` mode.
/// `Ok(None)` = a cancelled region drag, which the UI treats as a no-op.
#[tauri::command]
pub async fn capture_screenshot(
    app: tauri::AppHandle,
    mode: String,
    dir: String,
    title: Option<String>,
) -> Result<Option<Shot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Window mode goes through PrintWindow, which renders occluded windows
        // fine — only the screen and region grabs need us out of the shot.
        // Every visible window has to go, not just "main": a capture launched
        // from the search panel would otherwise photograph the search panel.
        let mut hidden = vec![];
        if mode != "window" {
            for w in app.webview_windows().values() {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                    hidden.push(w.clone());
                }
            }
            if !hidden.is_empty() {
                // Let the compositor actually finish putting them away.
                std::thread::sleep(std::time::Duration::from_millis(260));
            }
        }
        let res = capture_impl(&mode, &dir, title.as_deref());
        // Only windows we hid come back — a panel that closed itself first
        // stays closed, which is what a launcher should do.
        for w in &hidden {
            let _ = w.show();
        }
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Parse LIST_SHOTS_PS output. PowerShell collapses a single result to a bare
/// object — accept both. Anything unparsable → [].
fn parse_shot_list(json: &str, root: &PathBuf) -> Vec<Shot> {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let items: Vec<&serde_json::Value> = match &v {
        serde_json::Value::Array(a) => a.iter().collect(),
        serde_json::Value::Null => vec![],
        o => vec![o],
    };
    items
        .into_iter()
        .filter_map(|it| {
            let name = it.get("name")?.as_str()?.to_string();
            let num = |k: &str| it.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
            Some(Shot {
                path: root.join(&name).to_string_lossy().to_string(),
                name,
                width: num("width") as u32,
                height: num("height") as u32,
                taken_at: num("takenAt"),
                bytes: num("bytes") as u64,
                thumb: it
                    .get("thumb")
                    .and_then(|t| t.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
            })
        })
        .collect()
}

fn list_screenshots_impl(dir: &str) -> Result<Vec<Shot>, String> {
    let root = resolve_dir(dir)?;
    let script = std::env::temp_dir().join("cipher-manager-list-shots.ps1");
    std::fs::write(&script, LIST_SHOTS_PS)
        .map_err(|e| format!("couldn't write gallery script: {e}"))?;
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-Dir"])
        .arg(&root);
    commands::no_window(&mut c);
    let out = c.output().map_err(|e| format!("couldn't read the screenshots folder: {e}"))?;
    Ok(parse_shot_list(&String::from_utf8_lossy(&out.stdout), &root))
}

#[tauri::command]
pub async fn list_screenshots(dir: String) -> Result<Vec<Shot>, String> {
    tauri::async_runtime::spawn_blocking(move || list_screenshots_impl(&dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Full-size PNG as base64, for the lightbox.
#[tauri::command]
pub async fn read_screenshot(dir: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = shot_path(&dir, &name)?;
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        Ok(commands::base64_encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_screenshot_impl(dir: &str, name: &str) -> Result<(), String> {
    let p = shot_path(dir, name)?;
    run_shot_ps("copy", &p.to_string_lossy(), "")?;
    Ok(())
}

/// Put an already-taken screenshot back on the clipboard.
#[tauri::command]
pub async fn copy_screenshot(dir: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_screenshot_impl(&dir, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_screenshot(dir: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = shot_path(&dir, &name)?;
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Global hotkey
// ---------------------------------------------------------------------------

pub const SHOT_SHORTCUT: &str = "ctrl+alt+s";

/// Does this global-shortcut event belong to us rather than push-to-talk?
pub fn is_shot_shortcut(s: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    SHOT_SHORTCUT
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|k| &k == s)
        .unwrap_or(false)
}

/// Follow the settings toggle: (un)register Ctrl+Alt+S. Mirrors set_ptt_hotkey.
#[tauri::command]
pub fn set_shot_hotkey(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let registered = gs.is_registered(SHOT_SHORTCUT);
    if enabled && !registered {
        gs.register(SHOT_SHORTCUT).map_err(|e| e.to_string())
    } else if !enabled && registered {
        gs.unregister(SHOT_SHORTCUT).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// The hotkey fires the capture through the frontend, not directly: the target
/// folder is a frontend-owned setting and Rust never reads settings itself.
pub fn hotkey_pressed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit_to("main", "shot-hotkey", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_escape_the_folder_are_refused() {
        assert!(check_name("shot-20260724-101500.png").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name("..").is_err());
        assert!(check_name("../../etc/passwd").is_err());
        assert!(check_name(r"..\..\Windows\System32\config\SAM").is_err());
        assert!(check_name("sub/shot.png").is_err());
        assert!(check_name(r"sub\shot.png").is_err());
        assert!(check_name(r"C:\Windows\notepad.exe").is_err());
        assert!(check_name("shot\u{0}.png").is_err());
    }

    /// These constants are written to a .ps1 with no BOM, and Windows
    /// PowerShell then decodes the file as the system ANSI codepage. A UTF-8
    /// em-dash arrives as three CP1252 characters, the last of which is a
    /// right double-quote that silently ends whatever string it lands in.
    /// Cheap to guard, and it cost real debugging time to find.
    #[test]
    fn powershell_scripts_are_pure_ascii() {
        for (name, src) in [("SHOT_PS", SHOT_PS), ("LIST_SHOTS_PS", LIST_SHOTS_PS)] {
            if let Some((i, c)) = src.char_indices().find(|(_, c)| !c.is_ascii()) {
                let line = src[..i].matches('\n').count() + 1;
                panic!("{name} line {line} has non-ASCII {c:?} - PowerShell will mangle it");
            }
        }
    }

    #[test]
    fn size_line_parses() {
        assert_eq!(parse_size("1920x1080"), (1920, 1080));
        assert_eq!(parse_size("  800x600\r\n"), (800, 600));
        assert_eq!(parse_size("garbage"), (0, 0));
        assert_eq!(parse_size(""), (0, 0));
    }

    #[test]
    fn gallery_json_parses_array_and_single_object() {
        let root = PathBuf::from(r"C:\shots");
        let many = r#"[{"name":"a.png","width":1920,"height":1080,"takenAt":1750000000000,"bytes":523,"thumb":"aGk="},
                       {"name":"b.png","width":0,"height":0,"takenAt":0,"bytes":9,"thumb":null}]"#;
        let got = parse_shot_list(many, &root);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].width, 1920);
        assert_eq!(got[0].thumb.as_deref(), Some("aGk="));
        assert!(got[0].path.ends_with("a.png"));
        assert_eq!(got[1].thumb, None); // undecodable png → no thumb, still listed

        let one = r#"{"name":"solo.png","width":10,"height":10,"takenAt":1,"bytes":2}"#;
        let got = parse_shot_list(one, &root);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "solo.png");
        assert_eq!(got[0].thumb, None); // missing key tolerated

        assert!(parse_shot_list("not json", &root).is_empty());
        assert!(parse_shot_list("null", &root).is_empty()); // empty folder
    }

    #[test]
    fn unknown_modes_never_reach_powershell() {
        assert!(capture_impl("delete-everything", "", None).is_err());
    }

    /// Live probe: run a real full-screen grab on this machine through the
    /// actual capture path, then list it back. Also the only check that the
    /// PowerShell in SHOT_PS parses at all — a syntax error anywhere in the
    /// file, region overlay included, fails here.
    /// `cargo test -- --ignored --nocapture real_capture`
    #[test]
    #[ignore = "captures the live desktop — run explicitly"]
    fn real_capture() {
        let dir = std::env::temp_dir().join("cipher-manager-shot-test");
        let _ = std::fs::remove_dir_all(&dir);
        let d = dir.to_string_lossy().to_string();

        let shot = capture_impl("screen", &d, None)
            .expect("capture failed")
            .expect("screen mode should never report a cancel");
        eprintln!("captured {} — {}x{}, {} bytes", shot.name, shot.width, shot.height, shot.bytes);
        assert!(shot.width > 0 && shot.height > 0, "capture reported no size");
        assert!(shot.bytes > 1000, "PNG is suspiciously small ({} bytes)", shot.bytes);
        let header = std::fs::read(&shot.path).expect("saved file unreadable");
        assert_eq!(&header[..4], b"\x89PNG", "saved file is not a PNG");

        let listed = list_screenshots_impl(&d).expect("listing failed");
        assert_eq!(listed.len(), 1, "gallery didn't list the shot we just took");
        assert_eq!(listed[0].name, shot.name);
        assert_eq!(listed[0].width, shot.width, "listed size disagrees with capture");
        assert!(listed[0].thumb.is_some(), "no thumbnail generated");

        // Re-copy and delete both go through the confining path resolver.
        copy_screenshot_impl(&d, &shot.name).expect("re-copy failed");
        assert!(shot_path(&d, "../escape.png").is_err());
        std::fs::remove_file(&shot.path).ok();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shot_shortcut_is_parseable() {
        // A typo here would silently route Ctrl+Alt+S to push-to-talk instead.
        let k: tauri_plugin_global_shortcut::Shortcut =
            SHOT_SHORTCUT.parse().expect("SHOT_SHORTCUT must parse");
        assert!(is_shot_shortcut(&k));
    }
}
