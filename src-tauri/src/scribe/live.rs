//! The live watcher (Grammarly-style): a background thread that follows the
//! focused text field, docks the status nib to it, runs the debounced
//! auto-check, and pushes the nib/panel UI events. Ported from cipherScribe's
//! `spawn_nib_watcher` (desktop/src-tauri/src/lib.rs ~1081) plus the dispatch
//! half of its `start_check`.
//!
//! Rust never reads settings (CLAUDE.md), so the whole config — including
//! whether any of this runs at all — is pushed in from `ScribeRunner` in
//! App.tsx through `scribe_set_live`. Nothing starts on its own: the loop
//! polls the focused field and installs a system-wide keyboard hook, so it is
//! strictly opt-in and off by default.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::{thread, time::Duration};

use tauri::{AppHandle, Emitter, Manager};

use super::{net, uia};

/// How long a typing pause must last before we read + check the field.
const CHECK_DEBOUNCE_MS: u64 = 600;
/// Don't ship huge documents to LT on every pause.
///
/// `pub(super)`: `mod.rs`'s `hotkey_check` (Ctrl+Alt+G) checks the focused
/// field against this same ceiling — explicit user intent justifies skipping
/// the live loop's 3-char floor and debounce, not its size ceiling.
pub(super) const MAX_CHECK_BYTES: usize = 20_000;
/// Poll interval. Fast enough to follow a caret between fields, slow enough
/// that a UI Automation round trip per tick is invisible.
const TICK_MS: u64 = 350;

// --- Config, pushed in from the frontend ---------------------------------

/// Everything the loop needs that lives in frontend settings. Cloned once per
/// tick so no lock is held across a UI Automation call or a network check.
///
/// `pub(crate)`: `mod.rs`'s `hotkey_check`/`hotkey_rewrite` (Ctrl+Alt+G/R) read
/// `endpoint`/`token`/`language`/`style` via `network_config()`, and
/// `dispatch_check` takes the whole struct instead of three positional `&str`
/// — a named field can't be swapped past another one at a call site the way
/// three bare strings can.
#[derive(Clone)]
pub(crate) struct LiveConfig {
    pub(crate) enabled: bool,
    pub(crate) endpoint: String,
    /// `{{secret:scribe-token}}` — resolved against the vault in the network
    /// path (secrets.rs), never stored here in plaintext.
    pub(crate) token: String,
    pub(crate) language: String,
    /// Rewrite style wire value (`scribeRewriteStyle` in Settings — formal /
    /// casual / concise / expand / leet). Only `hotkey_rewrite` (Ctrl+Alt+R)
    /// reads this; there is no per-invocation picker (see its `ponytail:`
    /// note in `mod.rs`).
    pub(crate) style: String,
    pub(crate) ignore_fullscreen: bool,
    pub(crate) disabled_apps: Vec<String>,
}

static CONFIG: Mutex<LiveConfig> = Mutex::new(LiveConfig {
    enabled: false,
    endpoint: String::new(),
    token: String::new(),
    language: String::new(),
    style: String::new(),
    ignore_fullscreen: true,
    disabled_apps: Vec::new(),
});

/// One watcher thread per process, and one keyboard hook for the process'
/// lifetime (there is no unhook — turning the setting off stops the loop).
static RUNNING: AtomicBool = AtomicBool::new(false);
static HOOKED: AtomicBool = AtomicBool::new(false);

/// Clears `RUNNING` on drop rather than a plain store, so a panic mid-tick
/// (a poisoned `SESSION` lock — this codebase treats that as recoverable
/// elsewhere, see `unwrap_or_else(|e| e.into_inner())` at `mod.rs:664` — or a
/// panic inside a Tauri window call) still releases the flag on unwind. Without
/// this, a panicked watcher leaves `RUNNING == true` with no thread behind it,
/// and every later `scribe_set_live(true)` is a permanent no-op until the app
/// restarts.
struct RunFlag;
impl Drop for RunFlag {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Where the watcher last docked the nib (physical px) — the panel anchors to
/// it, including from `scribe_toggle_panel`, which has no other way to know.
static NIB_POS: Mutex<(i32, i32, i32, i32)> = Mutex::new((0, 0, 64, 30));

/// Push the live-nib settings into the watcher, starting it if this turned it
/// on. The only entry point: the loop never reads settings itself, and the
/// keyboard hook is installed here (inside `start`) rather than at app boot,
/// so a user who leaves `scribeNib` off never gets one.
#[tauri::command]
pub fn scribe_set_live(
    app: AppHandle,
    enabled: bool,
    endpoint: String,
    token: String,
    language: String,
    style: String,
    ignore_fullscreen: bool,
    disabled_apps: Vec<String>,
) {
    *CONFIG.lock().unwrap() = LiveConfig {
        enabled,
        endpoint,
        token,
        language,
        style,
        ignore_fullscreen,
        disabled_apps,
    };
    if enabled {
        start(app);
    }
    // Turning it off needs nothing here: the loop re-reads `enabled` at the top
    // of its next tick, hides both overlays, and exits.
}

/// Start the watcher. Idempotent — a second call while one is running is a
/// no-op, so every settings change can call it unconditionally.
pub fn start(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // already watching
    }
    if !HOOKED.swap(true, Ordering::SeqCst) {
        uia::install_keyboard_hook();
    }
    thread::spawn(move || {
        // Held for the rest of the closure so a panic anywhere below — inside
        // `watch`, or in the cleanup calls that follow it — still clears
        // RUNNING on unwind (see `RunFlag`'s doc comment).
        let run_flag = RunFlag;
        // Build both overlays up front: their webviews then have their
        // `nib_state`/`panel_data` listeners mounted long before the first
        // check emits one, and the docking math below reads the nib's real
        // size instead of falling back to the builder constant.
        let _ = super::overlay_window(&app, "nib", super::NIB_SIZE);
        let _ = super::overlay_window(&app, "panel", super::PANEL_SIZE);
        watch(&app);
        // Disabled: leave nothing floating.
        let _ = super::hide_overlay(&app, "nib");
        let _ = super::hide_overlay(&app, "panel");
        // Explicit, not just end-of-scope: RUNNING must be false BEFORE the
        // restart check below, or the nested `start()` call's swap sees it
        // still true (this guard hasn't dropped yet) and wrongly no-ops.
        drop(run_flag);
        // Closes the off-then-immediately-on race: a `start` that landed while
        // this thread was winding down saw RUNNING still true and did nothing,
        // which would leave the setting on with no watcher behind it.
        if CONFIG.lock().unwrap().enabled {
            start(app);
        }
    });
}

/// The tick loop. Returns when the setting goes off.
fn watch(app: &AppHandle) {
    let mut shown = false;
    let mut last = (i32::MIN, i32::MIN);
    // Which field we're tracking. Upstream kept this in the session; here the
    // session is only created when a check is dispatched (see `set_session`'s
    // two-step contract), so the loop owns "am I still on the same field".
    let mut current: Option<(isize, u64)> = None;

    loop {
        thread::sleep(Duration::from_millis(TICK_MS));
        let cfg = CONFIG.lock().unwrap().clone();
        if !cfg.enabled {
            return;
        }

        // A click that activated one of our overlays despite WS_EX_NOACTIVATE:
        // freeze the tick rather than tear the nib and panel down under the
        // user's cursor mid-click.
        if own_overlay_focused(app) {
            continue;
        }

        let paused = cfg.ignore_fullscreen && uia::fullscreen_foreground();
        let info = if paused { None } else { uia::focused_editable_info() };

        match info {
            Some(i) if i.pid != std::process::id() && !app_disabled(&cfg.disabled_apps, &i.exe) => {
                let switched = current != Some((i.hwnd, i.field_id));
                if switched {
                    current = Some((i.hwnd, i.field_id));
                    // The previous field's suggestions must not outlive it —
                    // on screen or in the session (see `clear_session`).
                    super::clear_session();
                    emit_nib_state(app, "idle", 0);
                    let _ = super::hide_overlay(app, "panel");
                }

                // Terminal panes are read-only for us (the UIA buffer is the
                // rendered screen, chrome and all), so no live checking — the
                // nib just docks as a launcher for the selection-based popups.
                //
                // Otherwise: a fresh field, or unchecked keystrokes followed by
                // a pause.
                if !i.terminal {
                    let stamp = uia::last_type_stamp();
                    if switched || should_check(uia::ms_since_type(), super::checked_stamp(), stamp)
                    {
                        look_at_field(app, &cfg, &i, stamp);
                    }
                }

                // Dock the nib to the field's bottom-right corner, with a little
                // move hysteresis so a jittery rect doesn't thrash SetWindowPos.
                let (nw, nh) = nib_size(app);
                let (fx, fy, fw, _) = i.rect;
                let (x, y) = dock_pos(i.rect, (nw, nh), monitor_at(app, fx + fw - 1, fy));
                if !shown || (x - last.0).abs() > 4 || (y - last.1).abs() > 4 {
                    let _ = super::scribe_show_nib(app.clone(), x, y);
                    last = (x, y);
                    *NIB_POS.lock().unwrap() = (x, y, nw, nh);
                    shown = true;
                    // Keep an open panel anchored to the nib as it moves.
                    if panel_visible(app) {
                        place_panel(app);
                    }
                }
            }
            _ => {
                if shown {
                    let _ = super::hide_overlay(app, "nib");
                    shown = false;
                }
                // Unconditional, not gated on `shown`: today the panel can only
                // open from the nib, so this never fires with the panel up and
                // the nib not — but a global hotkey (Task 9) that opens the
                // panel directly would otherwise leave it floating over an
                // unrelated app after a focus change.
                let _ = super::hide_overlay(app, "panel");
            }
        }
    }
}

/// Dispatch decision for one tick: only check once typing has actually paused,
/// and only once per pause. `checked_stamp` is the keyboard stamp a previous
/// dispatch already consumed (0 if none); `stamp` is the current one. Both are
/// tick counts from the keyboard hook, so `stamp > checked_stamp` means "keys
/// have landed since we last looked".
fn should_check(ms_since_type: u64, checked_stamp: u64, stamp: u64) -> bool {
    ms_since_type >= CHECK_DEBOUNCE_MS && stamp > checked_stamp
}

/// Read the field and either dispatch a check or consume the typing stamp.
/// The session always describes THIS field here — a focus switch clears it —
/// so its snapshot is what "have we already checked this text" compares to.
fn look_at_field(app: &AppHandle, cfg: &LiveConfig, i: &uia::FieldInfo, stamp: u64) {
    let Some(text) = uia::read_focused_text() else {
        return;
    };
    let snapshot = super::session_view().map(|(_, _, snapshot, _)| snapshot);
    if worth_checking(&text, snapshot.as_deref()) {
        dispatch_check(app, cfg, i, text);
        return;
    }
    // Nothing worth sending: consume the stamp so the next tick doesn't re-read
    // the same text. When the text IS new (too short, or past the size
    // ceiling), that also replaces the stale snapshot and clears its issues —
    // a visible state change, so the UI is pushed too.
    if snapshot.as_deref() == Some(text.as_str()) {
        super::mark_checked(stamp);
    } else if super::set_session(None, i.hwnd, i.field_id, i.exe.clone(), text, Vec::new()).is_some()
    {
        emit_nib_state(app, "idle", 0);
        emit_panel_data(app);
    }
}

/// Whether `text` is worth sending to LanguageTool: different from what we
/// already checked (`snapshot`, if any — `None` when no field is tracked yet),
/// with enough real content to be worth a round trip (`trim().len() >= 3`
/// filters empty/whitespace-only fields), and under the ~20 KB ceiling so a
/// huge document isn't shipped on every typing pause. **Preserve verbatim**
/// (per the plan) — `text.len()` is BYTES, not chars, matching upstream's
/// `start_check`; do not "fix" it into a char count.
fn worth_checking(text: &str, snapshot: Option<&str>) -> bool {
    snapshot != Some(text) && text.trim().len() >= 3 && text.len() <= MAX_CHECK_BYTES
}

/// The config currently known to the live loop. Kept fresh by
/// `scribe_set_live` regardless of whether the live loop itself is enabled —
/// `ScribeRunner`'s effect in App.tsx runs on every relevant settings change,
/// not only when `scribeNib` is on — so `mod.rs`'s hotkey_check/hotkey_rewrite
/// (Ctrl+Alt+G/R) can reuse it instead of plumbing a second settings mirror
/// into Rust just for them.
pub(crate) fn network_config() -> LiveConfig {
    CONFIG.lock().unwrap().clone()
}

/// Send `text` to LanguageTool off the tick thread and install the result.
///
/// Two-step session install (upstream's start_check / result split): this
/// dispatch is the ONLY call that writes `checked_stamp`, which is what stops
/// the debounce above from re-firing every 350 ms during one pause. The result
/// installs snapshot + issues under the gen captured here, or is discarded if
/// a newer check — or a different field — took the session over meanwhile.
///
/// The snapshot goes in empty on purpose: until the result lands there is no
/// text/issue pair the panel could act on, and the gen bump has already made
/// every rendered panel row stale.
///
/// `pub(crate)`, not private: `mod.rs`'s `hotkey_check` (Ctrl+Alt+G) calls this
/// directly for an on-demand check, bypassing the debounce entirely — it takes
/// the whole `LiveConfig` (now `pub(crate)`) rather than endpoint/token/
/// language as three positional `&str`, so a caller can't swap two of them
/// past each other and still compile clean.
pub(crate) fn dispatch_check(
    app: &AppHandle,
    cfg: &LiveConfig,
    i: &uia::FieldInfo,
    text: String,
) {
    let Some(gen) = super::set_session(
        None,
        i.hwnd,
        i.field_id,
        i.exe.clone(),
        String::new(),
        Vec::new(),
    ) else {
        return;
    };
    emit_nib_state(app, "checking", 0);
    let (app, hwnd, field_id, exe) = (app.clone(), i.hwnd, i.field_id, i.exe.clone());
    let (endpoint, token, language) = (cfg.endpoint.clone(), cfg.token.clone(), cfg.language.clone());
    thread::spawn(move || {
        // The frontend only ever sends the `{{secret:...}}` placeholder; the
        // real bearer token is resolved here, in the network path, exactly as
        // ai_proxy/tts_proxy do (secrets.rs).
        let token = crate::secrets::resolve_secrets(&token);
        match net::check(&text, &endpoint, &token, &language) {
            Ok(issues) => {
                let count = issues.len();
                if super::set_session(Some(gen), hwnd, field_id, exe, text, issues).is_some() {
                    emit_nib_state(&app, if count > 0 { "issues" } else { "clean" }, count);
                    emit_panel_data(&app);
                }
            }
            // A superseded failure stays quiet — a newer check is already in
            // flight and its "checking" state must not be replaced by a dead
            // one from the check it replaced.
            //
            // Route through `set_session`'s hwnd+field_id+gen check — same as
            // the success path gets for free — rather than comparing `gen`
            // alone. `gen` is drawn from a process-global counter (`NEXT_GEN`
            // in mod.rs) so a value really is unique across fields, but the
            // hwnd+field_id half is what keeps this in lockstep with
            // `set_session`'s contract rather than reimplementing half of it.
            // Writes back the same empty
            // snapshot/issues the optimistic install above already put there,
            // so a stale result from a field we've since left is discarded
            // exactly like the success path discards it.
            Err(_) => {
                if super::set_session(Some(gen), hwnd, field_id, exe, String::new(), Vec::new())
                    .is_some()
                {
                    emit_nib_state(&app, "error", 0);
                }
            }
        }
    });
}

/// Case-insensitive disabled-apps check (the list is hand-editable in Settings).
fn app_disabled(list: &[String], exe: &str) -> bool {
    list.iter().any(|e| e.eq_ignore_ascii_case(exe))
}

// --- UI events -----------------------------------------------------------
//
// The contract Task 7's `src/lib/scribe.ts` renders against:
//   nib_state  { status, count }   status ∈ idle|checking|clean|issues|error
//   panel_data { gen, exe, text, issues }  — `text` is the checked snapshot,
//   and every issue offset is a UTF-16 offset into exactly that string.

// `pub(super)`: `mod.rs`'s `hotkey_rewrite` (Ctrl+Alt+R) surfaces a rewrite
// failure through the same "error" nib state a live-loop check failure gets.
pub(super) fn emit_nib_state(app: &AppHandle, status: &str, count: usize) {
    let _ = app.emit("nib_state", serde_json::json!({ "status": status, "count": count }));
}

/// Push the live session to the panel. NEVER call while holding SESSION.
pub fn emit_panel_data(app: &AppHandle) {
    let (gen, exe, text, issues) = super::session_view().unwrap_or_default();
    let _ = app.emit(
        "panel_data",
        serde_json::json!({ "gen": gen, "exe": exe, "text": text, "issues": issues }),
    );
}

/// Re-push both events after a panel action (apply / apply-all / dismiss).
/// LOAD-BEARING: those actions bump the session's `gen`, so without this the
/// panel's cached gen is stale the instant one succeeds and every later click
/// is silently refused — see the contract note in src/lib/scribe.ts.
///
/// ponytail: no re-check is kicked afterwards (upstream's `kick_check`, lib.rs
/// ~752, ran one 900 ms later). An apply that CLEARS the session — the
/// line-ending mismatch in `do_apply` — is already re-checked by the loop on
/// its next tick, because `checked_stamp()` falls back to 0 with no session.
/// What's missing is only reconciliation after a clean apply: a fix that
/// cascades into a new issue (agreement rules) isn't noticed until the user
/// types again. Port `kick_check` here if that shows up in real use.
pub fn emit_after_action(app: &AppHandle) {
    match super::session_view() {
        Some((_, _, _, issues)) => {
            let count = issues.len();
            emit_nib_state(app, if count > 0 { "issues" } else { "clean" }, count);
        }
        // `do_apply` cleared the session outright (the line-ending-mismatch
        // path): the field still has unverified issues in it, we just can't
        // trust our offsets against it until the next check — "idle", not the
        // all-clear of "clean" (finding 5).
        None => emit_nib_state(app, "idle", 0),
    }
    emit_panel_data(app);
}

// --- Window geometry ------------------------------------------------------

/// Where the nib docks: just below the field's bottom-right corner, flipped
/// above when that would leave the monitor, clamped inside it either way. All
/// rects are (x, y, w, h) in physical pixels.
///
/// Below, not above (which is what upstream did): the strip above a field
/// belongs to the app's chrome, and for a field near the top of its window
/// that strip is the caption bar — the nib landed on top of
/// minimize/maximize/close and, being click-through-proof, ate the clicks.
/// Below can only cover the app's own content. The flip still exists, but it
/// only fires for a field against the monitor's bottom edge, which has no
/// titlebar above it to hit.
fn dock_pos(
    (fx, fy, fw, fh): (i32, i32, i32, i32),
    (nw, nh): (i32, i32),
    (mx, my, mw, mh): (i32, i32, i32, i32),
) -> (i32, i32) {
    let x = (fx + fw - nw - 8).clamp(mx + 6, (mx + mw - nw - 6).max(mx + 6));
    let mut y = fy + fh + 6;
    if y + nh > my + mh - 6 {
        y = fy - nh - 6;
    }
    (x, y.clamp(my + 6, (my + mh - nh - 6).max(my + 6)))
}

/// Where the panel anchors: right-aligned under the nib, flipped above when
/// clipped by the monitor's bottom edge, clamped inside it either way.
fn panel_pos(
    (nx, ny, nw, nh): (i32, i32, i32, i32),
    (pw, ph): (i32, i32),
    (mx, my, mw, mh): (i32, i32, i32, i32),
) -> (i32, i32) {
    let mut y = ny + nh + 8;
    if y + ph > my + mh - 8 {
        y = ny - ph - 8;
    }
    (
        (nx + nw - pw).clamp(mx + 8, (mx + mw - pw - 8).max(mx + 8)),
        y.clamp(my + 8, (my + mh - ph - 8).max(my + 8)),
    )
}

/// The monitor rect containing (x, y) — physical pixels.
fn monitor_at(app: &AppHandle, x: i32, y: i32) -> (i32, i32, i32, i32) {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .find_map(|m| {
            let (p, s) = (m.position(), m.size());
            (x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32)
                .then_some((p.x, p.y, s.width as i32, s.height as i32))
        })
        .unwrap_or((0, 0, 1920, 1080))
}

/// Position the panel against the nib. Runs the placement twice when a
/// cross-DPI move rescales the window (its physical size changes only after
/// the first set_position, so the first clamp used the wrong one).
pub fn place_panel(app: &AppHandle) {
    let Some(w) = app.get_webview_window("panel") else {
        return;
    };
    let nib = *NIB_POS.lock().unwrap();
    let monitor = monitor_at(app, nib.0 + nib.2 / 2, nib.1 + nib.3 / 2);
    for _ in 0..2 {
        let Ok(size) = w.outer_size() else { return };
        let (pw, ph) = (size.width as i32, size.height as i32);
        let (x, y) = panel_pos(nib, (pw, ph), monitor);
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        let now = w.outer_size().map(|s| (s.width as i32, s.height as i32));
        if now.unwrap_or((pw, ph)) == (pw, ph) {
            return; // no rescale — the clamp used the right size
        }
    }
}

fn panel_visible(app: &AppHandle) -> bool {
    app.get_webview_window("panel")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// The nib's real outer size, or the size it was built with before its window
/// exists.
fn nib_size(app: &AppHandle) -> (i32, i32) {
    app.get_webview_window("nib")
        .and_then(|w| w.outer_size().ok())
        .map(|s| (s.width as i32, s.height as i32))
        .unwrap_or(super::NIB_SIZE)
}

/// True when one of our own overlays is the foreground window.
fn own_overlay_focused(app: &AppHandle) -> bool {
    let fg = uia::foreground_window();
    if fg == 0 {
        return false; // no foreground window (or not Windows) — nothing to freeze for
    }
    ["nib", "panel"].iter().any(|label| {
        app.get_webview_window(label)
            .and_then(|w| super::window_hwnd(&w).ok())
            .is_some_and(|h| h == fg)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only check once typing has actually paused, and only once per pause.
    #[test]
    fn debounce_dispatches_once_per_pause() {
        assert!(!should_check(50, 0, 700)); // still typing
        assert!(should_check(800, 0, 700)); // paused, not yet checked
        assert!(!should_check(800, 800, 700)); // already checked this pause
    }

    /// A field nobody has ever typed into (`ms_since_type` = u64::MAX, no
    /// stamps) must not dispatch on the debounce — the focus switch is what
    /// checks it, exactly once.
    #[test]
    fn an_untouched_field_never_debounce_fires() {
        assert!(!should_check(u64::MAX, 0, 0));
    }

    /// The eligibility gate for a check dispatch: not identical to what we
    /// already checked, not near-empty, not over the size ceiling.
    #[test]
    fn worth_checking_skips_identical_text() {
        assert!(!worth_checking("hello world", Some("hello world")));
    }

    #[test]
    fn worth_checking_skips_near_empty_text() {
        assert!(!worth_checking("  ok  ", None)); // trims to "ok" — 2 chars
    }

    #[test]
    fn worth_checking_skips_text_over_the_ceiling() {
        let huge = "a".repeat(MAX_CHECK_BYTES + 1);
        assert!(!worth_checking(&huge, None));
    }

    #[test]
    fn worth_checking_flags_ordinary_new_text() {
        assert!(worth_checking("This sentance has a typo", None));
        assert!(worth_checking("new text", Some("old text")));
    }

    /// 1080p monitor at the origin, a field in the middle: the nib sits just
    /// below the field's bottom-right corner. A field at the very top of the
    /// screen — the case that used to land the nib on the caption buttons —
    /// still goes below. Only a field against the bottom edge flips above.
    #[test]
    fn nib_docks_below_the_field_and_flips_when_clipped() {
        let monitor = (0, 0, 1920, 1080);
        let nib = (64, 30);
        assert_eq!(dock_pos((400, 300, 500, 40), nib, monitor), (828, 346));
        let (_, y) = dock_pos((400, 0, 500, 40), nib, monitor);
        assert_eq!(y, 46, "titlebar territory above — still below the field");
        let (_, y) = dock_pos((400, 1020, 500, 40), nib, monitor);
        assert_eq!(y, 984, "no room below — dock above the field");
    }

    /// A field hard against the right edge can't push the nib off the monitor,
    /// and a second monitor's rect (negative origin) clamps to ITS bounds, not
    /// the primary's.
    #[test]
    fn nib_stays_on_its_monitor() {
        let (x, _) = dock_pos((1800, 300, 200, 40), (64, 30), (0, 0, 1920, 1080));
        assert_eq!(x, 1850, "clamped to the right edge minus the margin");
        let (x, y) = dock_pos((-1918, 10, 30, 40), (64, 30), (-1920, 0, 1920, 1080));
        assert_eq!((x, y), (-1914, 56), "clamped to the LEFT monitor, docked below");
    }

    /// The panel hangs under the nib, right-aligned with it, and flips above
    /// when the nib is near the bottom of the screen.
    #[test]
    fn panel_anchors_to_the_nib() {
        let monitor = (0, 0, 1920, 1080);
        assert_eq!(panel_pos((800, 200, 64, 30), (320, 220), monitor), (544, 238));
        let (_, y) = panel_pos((800, 1000, 64, 30), (320, 220), monitor);
        assert_eq!(y, 772, "no room below — flip above the nib");
    }

    /// Settings entries are hand-editable, so the exe match ignores case.
    #[test]
    fn disabled_apps_match_case_insensitively() {
        let list = vec!["Notepad.exe".to_string()];
        assert!(app_disabled(&list, "notepad.exe"));
        assert!(!app_disabled(&list, "code.exe"));
        assert!(!app_disabled(&[], "notepad.exe"));
    }
}
