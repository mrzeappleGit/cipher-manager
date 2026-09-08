//! CipherScribe: system-wide grammar checking and AI rewrite. Ported from the
//! standalone tray app at cipherScribe/desktop, which this replaces.
//! Windows-first (UI Automation); other platforms get inert stubs.

pub mod live;
pub mod net;
pub mod text;
pub mod uia;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::{thread, time::Duration};

use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use net::Issue;

impl text::OffsetRange for Issue {
    fn offset(&self) -> usize {
        self.offset
    }
    fn length(&self) -> usize {
        self.length
    }
    fn set_offset(&mut self, off: usize) {
        self.offset = off;
    }
}

// --- Session state -----------------------------------------------------

/// What the auto-check engine knows about the focused field: the text we last
/// checked (`snapshot`) and the issues LT returned for it. `gen` invalidates
/// stale async results and stale panel actions.
///
/// Ported from cipherScribe's `Session` (lib.rs ~24-51).
#[derive(Clone)]
struct Session {
    /// Bumped on EVERY snapshot/issue mutation — stale panel actions and
    /// in-flight check results must fail their gen comparison.
    gen: u64,
    hwnd: isize,
    /// UIA runtime-id hash of the field element (multi-field windows).
    field_id: u64,
    /// Lowercased exe basename — the panel's "Turn off for <exe>" footer.
    exe: String,
    snapshot: String,
    issues: Vec<Issue>,
    /// Keyboard stamp already consumed by a check dispatch (debounce marker).
    checked_stamp: u64,
}

/// Process-wide, monotonically increasing across every field's session for
/// the life of the process (finding 4) — `Session::new` used to restart at 0
/// for every field, so a stale gen held from field A's session could collide
/// with a fresh gen field B's session was handing out at the same count.
/// Starts at 1: `gen == 0` stays the crate-wide "no session" sentinel
/// (`session_gen()`'s `unwrap_or(0)`, `checked_stamp()`'s fallback, and the
/// panel's `PANEL_EMPTY.gen = 0` in src/lib/scribe.ts all rely on it) — a
/// session that itself started at 0 would collide with that sentinel on its
/// very first render.
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

/// The next generation. EVERY site that invalidates a gen draws from here
/// rather than incrementing the session's own counter — a per-session `+= 1`
/// would let a heavily-edited field climb into the range a later field is
/// still walking up through, and a stale click carrying the old value would
/// then be accepted against the new field.
fn next_gen() -> u64 {
    NEXT_GEN.fetch_add(1, Ordering::SeqCst)
}

impl Session {
    fn new(hwnd: isize, field_id: u64, exe: String) -> Self {
        Session {
            gen: next_gen(),
            hwnd,
            field_id,
            exe,
            snapshot: String::new(),
            issues: Vec::new(),
            checked_stamp: 0,
        }
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Serialize every clipboard save→set→paste→restore sequence.
static CLIP_LOCK: Mutex<()> = Mutex::new(());

/// Serialize whole apply pipelines (select + paste + verify). Two concurrent
/// applies would paste over each other's selections.
static APPLY_LOCK: Mutex<()> = Mutex::new(());

/// How long the target app gets to consume WM_PASTE before we restore the
/// user's clipboard under it.
const CLIP_SETTLE_MS: u64 = 160;

/// Current session generation (0 when no field is being tracked yet).
pub fn session_gen() -> u64 {
    SESSION.lock().unwrap().as_ref().map(|s| s.gen).unwrap_or(0)
}

/// Bump the live generation, invalidating every gen a caller may be holding.
///
/// New API (not present upstream) — the tested seam for the staleness
/// mechanism `Session::gen` implements. The real mutation sites below
/// (`set_session`, `apply_issue`/`apply_all`, `dismiss_issue`) still bump
/// `gen` inline themselves exactly as upstream did; this is for a caller with
/// no session-shaped mutation to make, e.g. "the user started typing again,
/// invalidate whatever's in flight" for the field currently tracked. A no-op
/// (returns 0) when no session exists yet — there is nothing in flight to
/// invalidate for a field that isn't being tracked, and manufacturing a
/// placeholder session here would hand out a gen that collides with whatever
/// real session `set_session` creates for it next.
pub fn bump_session() -> u64 {
    let mut guard = SESSION.lock().unwrap();
    match guard.as_mut() {
        Some(s) => {
            s.gen = next_gen();
            s.gen
        }
        None => 0,
    }
}

/// Whether `g` is still the live generation — the check every stale panel
/// click or in-flight check result must pass before it's allowed to touch
/// text.
pub fn gen_is_current(g: u64) -> bool {
    g == session_gen()
}

/// The live session as the panel renders it: (gen, exe, snapshot, issues).
/// `None` when no field is being tracked. Clones rather than handing out a
/// guard on purpose — every caller emits a Tauri event with the result, and
/// emitting while holding SESSION is how this deadlocks.
pub fn session_view() -> Option<(u64, String, String, Vec<Issue>)> {
    let guard = SESSION.lock().unwrap();
    guard
        .as_ref()
        .map(|s| (s.gen, s.exe.clone(), s.snapshot.clone(), s.issues.clone()))
}

/// Forget the tracked field. Upstream reset the session whenever focus moved
/// to a different field (lib.rs ~1141); it has to go somewhere, because the
/// panel renders straight out of the session and `do_apply` restores the
/// session's window before editing — a stale one would show the previous app's
/// suggestions and yank focus back to it to apply them. The next check
/// dispatch installs a fresh session for the new field.
pub fn clear_session() {
    *SESSION.lock().unwrap() = None;
}

/// The keyboard stamp a check dispatch has already consumed (0 when no session
/// exists — nothing has been checked, so any keystroke counts as new).
pub fn checked_stamp() -> u64 {
    SESSION.lock().unwrap().as_ref().map(|s| s.checked_stamp).unwrap_or(0)
}

/// Consume a typing stamp without checking: "I read the field for this pause
/// and there was nothing new to send." Keeps the live loop from re-reading the
/// same text on every tick of one pause. Deliberately does NOT bump `gen` —
/// nothing the panel rendered has changed.
pub fn mark_checked(stamp: u64) {
    if let Some(s) = SESSION.lock().unwrap().as_mut() {
        s.checked_stamp = stamp;
    }
}

/// Install (or refresh) the live session for a field, after a LanguageTool
/// check has completed for it. Reuses the session if it's for the same field
/// (bumping gen); otherwise starts a fresh one. Returns the new gen, or
/// `None` if the result was superseded and must be discarded.
///
/// Mirrors the session get-or-create + gen-bump half of cipherScribe's
/// `start_check` (lib.rs ~698-711) — the network-dispatch half (calling
/// `net::check` and emitting nib/panel UI events) belongs to Task 8's polling
/// loop, which has the `AppHandle` this module deliberately doesn't take.
///
/// `expect_gen` guards against exactly the race upstream's split dispatch/
/// install steps prevent: an in-flight check result landing after a NEWER
/// check (or a different field) already took over the session. Pass the gen
/// captured when this check was dispatched; if the live session has since
/// moved on (a newer install bumped `gen`, or `hwnd` changed), the live
/// state's comparison and this write happen under one lock acquisition so
/// the check-then-write can't race a concurrent caller, and the stale result
/// is discarded (`None`) instead of overwriting newer data. `None` for
/// `expect_gen` keeps the unconditional install used for a field's first
/// snapshot / a fresh dispatch.
pub fn set_session(
    expect_gen: Option<u64>,
    hwnd: isize,
    field_id: u64,
    exe: String,
    snapshot: String,
    issues: Vec<Issue>,
) -> Option<u64> {
    let mut guard = SESSION.lock().unwrap();
    if let Some(g) = expect_gen {
        let still_current =
            matches!(guard.as_ref(), Some(s) if s.gen == g && s.hwnd == hwnd && s.field_id == field_id);
        if !still_current {
            return None; // superseded by a newer dispatch/result — discard
        }
    }
    let sess = match guard.as_mut() {
        Some(s) if s.hwnd == hwnd && s.field_id == field_id => s,
        _ => {
            *guard = Some(Session::new(hwnd, field_id, exe));
            guard.as_mut().unwrap()
        }
    };
    sess.snapshot = snapshot;
    sess.issues = issues;
    sess.gen = next_gen();
    if expect_gen.is_none() {
        sess.checked_stamp = uia::last_type_stamp();
    }
    Some(sess.gen)
}

// --- Input simulation -------------------------------------------------------

fn clipboard_text() -> Option<String> {
    Clipboard::new().ok().and_then(|mut c| c.get_text().ok())
}

/// Release the modifier keys the user is still physically holding from the
/// hotkey, so our synthetic Ctrl+C/Ctrl+V isn't interpreted as Ctrl+Alt+key.
fn release_modifiers(enigo: &mut Enigo) {
    for k in [Key::Alt, Key::Control, Key::Shift, Key::Meta] {
        let _ = enigo.key(k, Direction::Release);
    }
}

fn paste() {
    if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
        release_modifiers(&mut enigo);
        thread::sleep(Duration::from_millis(40));
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Unicode('v'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }
}

fn select_all() {
    if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
        release_modifiers(&mut enigo);
        thread::sleep(Duration::from_millis(40));
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Unicode('a'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }
}

/// Set the clipboard to `replacement`, paste it over the current selection,
/// and restore the user's clipboard text afterwards. When `expected_field` is
/// given, the field is polled until the paste has landed (or ~600 ms) before
/// the clipboard is restored, so a slow consumer can't paste the restored old
/// content instead.
fn paste_over_selection(replacement: &str, expected_field: Option<&str>) {
    let _guard = CLIP_LOCK.lock().unwrap();
    let prior = clipboard_text();
    if let Ok(mut cb) = Clipboard::new() {
        let _ = cb.set_text(replacement);
    }
    thread::sleep(Duration::from_millis(30));
    paste();
    match expected_field {
        Some(exp) => {
            for _ in 0..12 {
                thread::sleep(Duration::from_millis(50));
                if uia::read_focused_text().as_deref() == Some(exp) {
                    break;
                }
            }
        }
        // No way to verify — give the target a fixed window to consume WM_PASTE.
        None => thread::sleep(Duration::from_millis(CLIP_SETTLE_MS)),
    }
    if let (Ok(mut cb), Some(p)) = (Clipboard::new(), prior) {
        let _ = cb.set_text(p);
    }
}

/// Marks a just-set clipboard so `copy_selection` can tell whether the target
/// app actually copied something, rather than trusting a clipboard that may
/// simply be stale from before the hotkey was pressed.
const SELECTION_SENTINEL: &str = "\u{0}__cipherscribe__\u{0}";

/// Copy the current selection and return it, restoring the prior clipboard
/// either way. Returns "" if nothing was actually copied (no selection, or the
/// app ate the keystroke) — callers must treat that as "nothing to act on",
/// never as an empty-but-real selection.
///
/// Ported from cipherScribe's `copy_selection` (upstream lib.rs 390-420); the
/// fallback both hotkey flows (Task 9) use when a field doesn't expose its
/// full value to UI Automation (e.g. a terminal), mirroring upstream's own
/// `trigger()`.
fn copy_selection() -> String {
    let _guard = CLIP_LOCK.lock().unwrap();
    let prior = clipboard_text();
    if let Ok(mut cb) = Clipboard::new() {
        let _ = cb.set_text(SELECTION_SENTINEL);
    }
    if let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) {
        release_modifiers(&mut enigo);
        thread::sleep(Duration::from_millis(60));
        // Ctrl+Insert, not Ctrl+C: same copy everywhere, but in a terminal
        // with no selection it's a no-op instead of a SIGINT.
        let _ = enigo.key(Key::Control, Direction::Press);
        let _ = enigo.key(Key::Insert, Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }
    // Poll until the clipboard changes from the sentinel (copy latency varies).
    for _ in 0..24 {
        thread::sleep(Duration::from_millis(25));
        if let Some(t) = clipboard_text() {
            if t != SELECTION_SENTINEL && !t.trim().is_empty() {
                return t;
            }
        }
    }
    // Nothing was copied (no selection / copy blocked): restore + bail.
    if let (Ok(mut cb), Some(p)) = (Clipboard::new(), prior) {
        let _ = cb.set_text(p);
    }
    String::new()
}

/// One in-place replacement in the focused field, whose current text must be
/// exactly `snapshot`. Ladder:
/// 1. TextPattern: select a VERIFIED range and paste over it (preserves the
///    app's undo stack, formatting, and caret locality).
/// 2. ValuePattern: swap the whole text for the spliced version.
/// 3. Select-all + paste the spliced text (last resort).
fn replace_in_field(snapshot: &str, offset: usize, length: usize, replacement: &str) -> bool {
    const CTX_UNITS: usize = 12;
    let Some(expected) = text::slice_u16(snapshot, offset, length) else {
        return false;
    };
    let Some(spliced) = text::splice_u16(snapshot, offset, length, replacement) else {
        return false;
    };
    let candidates = text::unit_candidates(snapshot, offset, length, CTX_UNITS);
    // When the flagged text appears more than once, verify surroundings too so
    // a mis-counted candidate can't land on an identical other occurrence.
    let ctx = (snapshot.matches(expected).count() > 1)
        .then(|| text::context_slice(snapshot, offset, length, CTX_UNITS));
    if uia::select_focused_range(&candidates, &text::normalize_newlines(expected), ctx.as_deref())
    {
        paste_over_selection(replacement, Some(&spliced));
        return true;
    }
    // Rungs 2/3 rewrite the WHOLE field from `snapshot` — only valid while the
    // field still holds exactly that text (rung 1 failing can also mean the
    // user typed mid-flight; blindly swapping would wipe their keystrokes).
    if uia::read_focused_text().as_deref() != Some(snapshot) {
        return false;
    }
    if uia::set_focused_text(&spliced) {
        return true;
    }
    let _guard = CLIP_LOCK.lock().unwrap();
    let prior = clipboard_text();
    if let Ok(mut cb) = Clipboard::new() {
        let _ = cb.set_text(&spliced);
    }
    thread::sleep(Duration::from_millis(40));
    select_all();
    thread::sleep(Duration::from_millis(40));
    paste();
    thread::sleep(Duration::from_millis(CLIP_SETTLE_MS));
    if let (Ok(mut cb), Some(p)) = (Clipboard::new(), prior) {
        let _ = cb.set_text(p);
    }
    true
}

// --- Apply engine ------------------------------------------------------

/// Apply one or more issues in place. `jobs` are (issue index, replacement)
/// pairs against the session's CURRENT issue list; the batch is applied
/// highest-offset-first so earlier offsets never shift underneath it.
///
/// Ported from cipherScribe's `do_apply` (lib.rs ~786-894). Upstream also
/// took an `AppHandle` to emit nib/panel UI events and to kick a ~900ms
/// reconciliation re-check after a successful batch (fixes can cascade, e.g.
/// agreement rules) — that wiring belongs to Task 6 (commands/events) and
/// Task 8 (the polling loop that owns re-checking); this leaves the session
/// in the state those callers need (cleared on a line-ending mismatch,
/// updated with the post-apply snapshot/issues otherwise) without emitting
/// anything itself.
fn do_apply(gen: u64, jobs: Vec<(usize, String)>) {
    // One apply at a time — a concurrent sibling would paste over the range
    // this one just selected. Re-validate gen AFTER acquiring, then bump it so
    // any queued duplicate click (same gen) becomes a stale no-op.
    let _apply = APPLY_LOCK.lock().unwrap();
    let (my_gen, hwnd, mut snapshot, mut issues) = {
        let mut guard = SESSION.lock().unwrap();
        match guard.as_mut() {
            Some(s) if s.gen == gen => {
                // Whoever calls this MUST re-emit panel_data afterwards — this
                // bump makes the panel's cached gen stale, so without a fresh
                // emit every later click is a silent no-op and the panel looks
                // frozen. Contract is spelled out in src/lib/scribe.ts.
                s.gen = next_gen();
                (s.gen, s.hwnd, s.snapshot.clone(), s.issues.clone())
            }
            _ => return, // stale panel action
        }
    };

    // The target app must be foreground for UIA + paste to land in it. With a
    // no-activate panel it still is; if the click activated us anyway, put the
    // target back first.
    if uia::foreground_window() != hwnd {
        uia::set_foreground(hwnd);
        thread::sleep(Duration::from_millis(150));
        if uia::foreground_window() != hwnd {
            return;
        }
    }

    // The field must still hold exactly what we checked — otherwise offsets
    // are meaningless and we'd be guessing instead of re-checking.
    let current = uia::read_focused_text().unwrap_or_default();
    if current != snapshot {
        return;
    }

    // Materialize the jobs (with the text each one expects at its offset) and
    // order them by descending offset.
    let mut ordered: Vec<(Issue, String, String)> = jobs
        .into_iter()
        .filter_map(|(idx, repl)| {
            let it = issues.get(idx).cloned()?;
            let word = text::slice_u16(&snapshot, it.offset, it.length)?.to_string();
            Some((it, repl, word))
        })
        .collect();
    ordered.sort_by(|a, b| b.0.offset.cmp(&a.0.offset));

    for (it, repl, word) in ordered {
        // A previous step in this batch may have rewritten this issue's span
        // (overlapping suggestions): the recorded offsets are then stale and
        // splicing there would corrupt text — skip.
        if text::slice_u16(&snapshot, it.offset, it.length) != Some(word.as_str()) {
            continue;
        }
        let Some(expect) = text::splice_u16(&snapshot, it.offset, it.length, &repl) else {
            continue;
        };
        if !replace_in_field(&snapshot, it.offset, it.length, &repl) {
            break;
        }
        thread::sleep(Duration::from_millis(60));
        let now = uia::read_focused_text().unwrap_or_default();
        if now != expect {
            // Normalized-equal means the app rewrote line endings under us:
            // the edit landed but our offsets are off — drop the session so a
            // stale one can't be trusted, and let the caller re-check.
            *SESSION.lock().unwrap() = None;
            return;
        }
        snapshot = expect;
        // Drop the applied issue + anything overlapping; shift the rest.
        let delta = text::utf16_len(&repl) as isize - it.length as isize;
        if let Some(pos) = issues
            .iter()
            .position(|x| x.offset == it.offset && x.length == it.length && x.message == it.message)
        {
            issues.remove(pos);
        }
        text::shift_offsets(&mut issues, it.offset, it.length, delta);

        // Persist progress so a mid-batch failure doesn't lose applied fixes.
        let mut guard = SESSION.lock().unwrap();
        match guard.as_mut() {
            Some(s) if s.gen == my_gen && s.hwnd == hwnd => {
                s.snapshot = snapshot.clone();
                s.issues = issues.clone();
            }
            _ => return, // superseded mid-batch — its result wins
        }
    }
}

/// Apply a single suggestion. Ported from cipherScribe's `apply_issue`
/// (lib.rs ~896-899), minus the `thread::spawn` — this is now a plain
/// blocking call; the caller (a Task 6 tauri command) is responsible for
/// running it off the async runtime (e.g. `spawn_blocking`, matching how the
/// rest of this codebase offloads blocking work).
pub fn apply_issue(gen: u64, index: usize, replacement: String) {
    do_apply(gen, vec![(index, replacement)]);
}

/// Apply every unambiguous correction (Grammarly's "Fix all"). Ported from
/// cipherScribe's `apply_all` (lib.rs ~902-920), same threading note as
/// `apply_issue`.
pub fn apply_all(gen: u64) {
    let jobs = {
        let guard = SESSION.lock().unwrap();
        match &*guard {
            Some(s) if s.gen == gen => s
                .issues
                .iter()
                .enumerate()
                .filter(|(_, it)| it.unambiguous())
                .map(|(i, it)| (i, it.replacements[0].clone()))
                .collect::<Vec<_>>(),
            _ => return,
        }
    };
    do_apply(gen, jobs);
}

/// Drop one issue from the session without editing any text. Ported from
/// cipherScribe's `dismiss_issue` (lib.rs ~922-939), minus the UI event emit.
pub fn dismiss_issue(gen: u64, index: usize) {
    let mut guard = SESSION.lock().unwrap();
    if let Some(s) = guard.as_mut() {
        if s.gen == gen && index < s.issues.len() {
            s.issues.remove(index);
            // Same contract as do_apply: re-emit panel_data after this, or the
            // panel's cached gen is stale and every later click no-ops.
            s.gen = next_gen(); // a queued second click must not hit shifted indices
        }
    }
}

/// Replace the WHOLE focused field with `text` — via UIA SetValue, else
/// select-all + paste. Unlike `do_apply`, this doesn't splice at an offset (a
/// rewrite's output has no offsets left to trust against the original), so it
/// drops the field's live session outright rather than updating it in place.
///
/// Ported from cipherScribe's `apply` (upstream lib.rs 526-559), minus the
/// `popup` window hide (this fold-in never ports `popup`, see the plan) and
/// `LAST_FIELD` (there a continuously-updated static the popup UI could act on
/// long after the fact; here the caller — `hotkey_rewrite` — captures the hwnd
/// itself at hotkey-press time and hands it straight in). Blocking, same as
/// `do_apply`: run it off whatever thread must stay responsive.
fn apply_whole_field(hwnd: isize, text: &str) {
    let _apply = APPLY_LOCK.lock().unwrap();
    uia::set_foreground(hwnd);
    thread::sleep(Duration::from_millis(180));
    // A whole-field replace invalidates any live session tracking this field —
    // its offsets no longer describe anything real.
    *SESSION.lock().unwrap() = None;
    if uia::set_focused_text(text) {
        return;
    }
    let _guard = CLIP_LOCK.lock().unwrap();
    let prior = clipboard_text();
    if let Ok(mut cb) = Clipboard::new() {
        let _ = cb.set_text(text);
    }
    thread::sleep(Duration::from_millis(40));
    select_all();
    thread::sleep(Duration::from_millis(40));
    paste();
    thread::sleep(Duration::from_millis(CLIP_SETTLE_MS));
    if let (Ok(mut cb), Some(p)) = (Clipboard::new(), prior) {
        let _ = cb.set_text(p);
    }
}

// --- Panel command surface -----------------------------------------------
//
// Thin `#[tauri::command]` wrappers over the three apply-engine fns above.
// `apply_issue`/`apply_all` run the full UI Automation + clipboard + synthetic
// keyboard sequence on the calling thread (seconds for a multi-issue
// `apply_all`), so they're dispatched via `spawn_blocking` rather than run
// inline on an async command body — the same pattern `commands.rs` uses for
// every blocking fn it exposes (e.g. `list_vault`, `vault_doctor`). All three
// return `Result<(), String>`: the panel doesn't distinguish "applied" from
// "refused as stale" from "session cleared" (nothing in this task's UI reads
// that distinction), only "the call itself failed" — a real command panic or
// join error, surfaced instead of silently swallowed.
//
// All three end in `live::emit_after_action`, because all three bump `gen` on
// success: without a fresh `panel_data` the panel's cached gen is stale and
// every later click is silently refused (see src/lib/scribe.ts).

#[tauri::command]
pub async fn scribe_apply_issue(
    app: AppHandle,
    gen: u64,
    index: usize,
    replacement: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || apply_issue(gen, index, replacement))
        .await
        .map_err(|e| e.to_string())?;
    live::emit_after_action(&app);
    Ok(())
}

#[tauri::command]
pub async fn scribe_apply_all(app: AppHandle, gen: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || apply_all(gen))
        .await
        .map_err(|e| e.to_string())?;
    live::emit_after_action(&app);
    Ok(())
}

#[tauri::command]
pub async fn scribe_dismiss_issue(app: AppHandle, gen: u64, index: usize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || dismiss_issue(gen, index))
        .await
        .map_err(|e| e.to_string())?;
    live::emit_after_action(&app);
    Ok(())
}

// --- Nib and suggestions-panel windows ----------------------------------

/// One glyph plus its border — `ScribeNib.tsx`'s button fills this whole
/// window, and it renders exactly one glyph in every state (the issue count
/// replaces the pen rather than sitting beside it) so this stays constant.
/// Keep it tight: the window is transparent but not click-through, so every
/// pixel of it eats clicks on the app's own send/submit button, which is what
/// sits under the field's bottom-right corner where the nib docks.
const NIB_SIZE: (i32, i32) = (22, 22);
const PANEL_SIZE: (i32, i32) = (320, 220);

/// Get-or-create one of the two floating overlay windows (the status nib /
/// the suggestions panel). Both are built the same way cipherScribe's
/// `tauri.conf.json` declared them (decorations off, always-on-top,
/// non-resizable, transparent, no shadow, hidden and unfocused at creation),
/// ported here as builder calls instead — same get-or-create shape as
/// `search_window()` in lib.rs. `index.html` for both: Task 7 routes on the
/// window label.
///
/// Immediately after `build()`, the window is made non-activating
/// (WS_EX_NOACTIVATE) via `uia::set_noactivate`. This is the single most
/// important behaviour of these windows: without it, clicking the nib or
/// panel would steal focus from the text field being edited, and the apply
/// engine's "read the focused field" calls would read the wrong window.
fn overlay_window(app: &AppHandle, label: &str, (width, height): (i32, i32)) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(label) {
        return Ok(existing);
    }
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .inner_size(width as f64, height as f64)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .transparent(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Close on failure: a window that got built but never received
    // WS_EX_NOACTIVATE would be handed straight back by the get-or-create
    // above on the next call, permanently activating and silently so.
    let hwnd = match window_hwnd(&win) {
        Ok(h) => h,
        Err(e) => {
            let _ = win.close();
            return Err(e);
        }
    };
    uia::set_noactivate(hwnd);
    Ok(win)
}

#[cfg(windows)]
fn window_hwnd(w: &WebviewWindow) -> Result<isize, String> {
    w.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string())
}

// ponytail: uia's own calls are already no-ops off Windows, but
// `WebviewWindow::hwnd()` itself is `#[cfg(windows)]` in Tauri — this stub is
// what lets `overlay_window` compile at all on non-Windows targets. The fake
// handle is inert everywhere it's passed, since every `uia::` fn ignores it
// off Windows.
#[cfg(not(windows))]
fn window_hwnd(_: &WebviewWindow) -> Result<isize, String> {
    Ok(0)
}

/// Show the nib at `(x, y)` (physical pixels), without activating it. The
/// caller (Task 8's field watcher) owns deciding where that is — this just
/// moves and shows.
///
/// Plain fn, not a `#[tauri::command]` (finding 6) — its only caller is
/// `live.rs`'s `watch()`, which calls it directly; there is no JS caller.
pub fn scribe_show_nib(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    let win = overlay_window(&app, "nib", NIB_SIZE)?;
    let hwnd = window_hwnd(&win)?;
    // `NIB_SIZE` went into `inner_size()` as LOGICAL pixels; `SetWindowPos`
    // wants PHYSICAL ones. `outer_size()` reports the window's actual
    // physical footprint, so reuse that instead of re-deriving it from
    // `NIB_SIZE` and a scale factor.
    let size = win.outer_size().map_err(|e| e.to_string())?;
    uia::move_no_activate(hwnd, x, y, size.width as i32, size.height as i32);
    uia::show_no_activate(hwnd);
    Ok(())
}

/// Place and show the panel, anchored to wherever the watcher last docked the
/// nib (or its default position, if the live watcher has never run), and push
/// the current session — `panel_data` is otherwise only emitted when a check
/// completes, so a panel opened between checks would render empty.
///
/// Shared by `scribe_toggle_panel`'s "currently hidden" branch and
/// `hotkey_check` (Ctrl+Alt+G), which must always show the panel rather than
/// toggle it closed on a second press.
fn show_panel(app: &AppHandle) -> Result<(), String> {
    let w = overlay_window(app, "panel", PANEL_SIZE)?;
    let hwnd = window_hwnd(&w)?;
    live::place_panel(app);
    // Data before show: the webview re-renders while still hidden, so a panel
    // reopened on a new field can't flash the previous one's rows.
    live::emit_panel_data(app);
    uia::show_no_activate(hwnd);
    Ok(())
}

/// Flip the suggestions panel between shown and hidden, without activating it
/// (so the field being corrected keeps focus and the apply flow can land).
#[tauri::command]
pub fn scribe_toggle_panel(app: AppHandle) -> Result<(), String> {
    let w = overlay_window(&app, "panel", PANEL_SIZE)?;
    let hwnd = window_hwnd(&w)?;
    if w.is_visible().unwrap_or(false) {
        uia::hide_window(hwnd);
        Ok(())
    } else {
        show_panel(&app)
    }
}

/// Hide the suggestions panel without destroying it.
#[tauri::command]
pub fn scribe_hide_panel(app: AppHandle) -> Result<(), String> {
    hide_overlay(&app, "panel")
}

/// Shared body of `scribe_hide_nib`/`scribe_hide_panel`: hide a window by
/// label if it's been created, without destroying it. A no-op if the window
/// was never shown yet.
fn hide_overlay(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        uia::hide_window(window_hwnd(&w)?);
    }
    Ok(())
}

// --- Global hotkeys -------------------------------------------------------
//
// Ctrl+Alt+G (check) and Ctrl+Alt+R (rewrite) — the two shortcuts this fold-in
// adds to the five-shortcut namespace lib.rs now dispatches explicitly (see
// its `with_handler` closure). Both follow one settings toggle
// (`scribeHotkeys`), registered/unregistered together by `set_scribe_hotkeys`.

pub const CHECK_SHORTCUT: &str = "ctrl+alt+g";
pub const REWRITE_SHORTCUT: &str = "ctrl+alt+r";

/// Does this global-shortcut event belong to Ctrl+Alt+G (check)? Mirrors
/// `shot::is_shot_shortcut`.
pub fn is_check_shortcut(s: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    CHECK_SHORTCUT
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|k| &k == s)
        .unwrap_or(false)
}

/// Does this global-shortcut event belong to Ctrl+Alt+R (rewrite)?
pub fn is_rewrite_shortcut(s: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    REWRITE_SHORTCUT
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|k| &k == s)
        .unwrap_or(false)
}

/// Follow the settings toggle: (un)register both Ctrl+Alt+G and Ctrl+Alt+R.
/// Mirrors `shot::set_shot_hotkey` exactly, just over two keys instead of one
/// — each checks `is_registered` first, so a repeated call (or a call after
/// one of the two already failed to register elsewhere) stays idempotent.
///
/// Attempts BOTH keys unconditionally rather than bailing via `?` on the
/// first failure — otherwise a failed R leaves G claimed with no way for the
/// caller to know, since the returned `Err` only ever named the first
/// failure and the toggle would read as fully off/on either way.
#[tauri::command]
pub fn set_scribe_hotkeys(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let mut errors = Vec::new();
    for key in [CHECK_SHORTCUT, REWRITE_SHORTCUT] {
        let registered = gs.is_registered(key);
        let result = if enabled && !registered {
            gs.register(key)
        } else if !enabled && registered {
            gs.unregister(key)
        } else {
            Ok(())
        };
        if let Err(e) = result {
            errors.push(format!("{key}: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Field this hotkey should act on right now: the focused field's full text
/// (preferred, since it's what both `do_apply` and a rewrite need to splice
/// or replace) — except in a terminal, where UI Automation's "full text" IS
/// the rendered screen buffer, chrome and all (`FieldInfo::terminal`), so we
/// use the current selection there instead, same as the live watcher
/// (`live.rs`'s `watch`). `None` when there's nothing to act on — no focused
/// field, our own overlay somehow has focus, or the selection is also empty —
/// mirroring upstream's `trigger()`, which bails the same way.
fn hotkey_target() -> Option<(uia::FieldInfo, String)> {
    let i = uia::focused_editable_info()?;
    if i.pid == std::process::id() {
        return None; // our own nib/panel somehow has focus — nothing to act on
    }
    let text = if i.terminal {
        copy_selection()
    } else {
        uia::read_focused_text().filter(|t| !t.trim().is_empty()).unwrap_or_else(copy_selection)
    };
    if text.trim().is_empty() {
        return None;
    }
    Some((i, text))
}

/// Ctrl+Alt+G: force an on-demand check of the focused field right now,
/// bypassing the live loop's debounce, and show the panel with the result.
/// Works whether or not the live nib (`scribeNib`) is even on — endpoint/
/// token/language come from `live::network_config()`, which `ScribeRunner` in
/// App.tsx keeps current regardless of that toggle.
///
/// The whole body runs off the main thread: `tauri-plugin-global-shortcut`
/// invokes this handler synchronously from the message-only window's wndproc
/// on Windows, while holding the plugin's shortcut mutex — `hotkey_target()`'s
/// clipboard/UIA round trip (worst case: 60ms select-all wait plus 24×25ms of
/// clipboard polling) would otherwise freeze the whole app and every other
/// hotkey/`set_*_hotkey` call for that long. Mirrors upstream's `trigger()`
/// (cipherScribe desktop/src-tauri/src/lib.rs ~630), which makes
/// `thread::spawn` its first statement for the same reason.
pub fn hotkey_check(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let Some((i, text)) = hotkey_target() else { return };
        // Explicit user intent skips the live loop's 3-char floor and debounce,
        // but not its size ceiling — a multi-megabyte buffer still shouldn't
        // go over the wire whole.
        if text.len() > live::MAX_CHECK_BYTES {
            eprintln!(
                "scribe: field is {} bytes, over the {} byte check ceiling",
                text.len(),
                live::MAX_CHECK_BYTES
            );
            live::emit_nib_state(&app, "error", 0);
            return;
        }
        let cfg = live::network_config();
        live::dispatch_check(&app, &cfg, &i, text);
        // Best-effort: a placement/window failure here shouldn't be a panic, and
        // there's nothing more actionable to do with it than log it.
        if let Err(e) = show_panel(&app) {
            eprintln!("scribe: couldn't show the panel for Ctrl+Alt+G: {e}");
        }
    });
}

/// The rewrite styles the endpoint accepts, as wire values. The UI labels
/// ("L33t", "Improve prompt") are the frontend's business — these lowercase
/// codes are the contract, mirrored in `REWRITE_STYLES` in src/lib/scribe.ts
/// and keyed by the proxy's `STYLES` map
/// (cipherScribe/deploy/rewrite-proxy/server.mjs). That map falls back to
/// `formal` for anything it doesn't know, so a value accepted here but missing
/// there produces a wrong rewrite with no error — hence the guard in
/// `scribe_rewrite`.
pub const REWRITE_STYLES: [&str; 6] =
    ["formal", "casual", "concise", "expand", "leet", "prompt"];

/// Send the focused field (or the selection) to the rewrite endpoint and paste
/// the result back over the whole field.
///
/// `style` of `None` uses the user's configured default (`scribeRewriteStyle`
/// in Settings, plumbed through `LiveConfig.style` — see
/// `live::network_config()`); `Some` is the panel's per-invocation picker.
/// Shared by Ctrl+Alt+R, the tray entry, and the panel so the three cannot
/// drift apart.
///
/// The whole body runs off the main thread — same reasoning as `hotkey_check`
/// above: `hotkey_target()`'s blocking capture must not run inline in the
/// global-shortcut callback (and, from the panel, must not block a Tauri
/// runtime worker).
fn rewrite_with(app: &AppHandle, style: Option<String>) {
    let app = app.clone();
    thread::spawn(move || {
        let Some((i, text)) = hotkey_target() else { return };
        let cfg = live::network_config();
        let hwnd = i.hwnd;
        let token = crate::secrets::resolve_secrets(&cfg.token);
        // `LiveConfig`'s const-initialized default is `style: String::new()`
        // while the settings default is "formal", so an empty value here means
        // "nothing pushed yet", not "the user chose blank".
        let style = style
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| cfg.style.clone());
        let style = if style.is_empty() { "formal" } else { &style };
        match net::rewrite(&text, style, &cfg.endpoint, &token) {
            Ok(rewritten) => {
                apply_whole_field(hwnd, &rewritten);
                // The whole-field replace just cleared this field's live session
                // (see `apply_whole_field`) — push that to the nib/panel, or a
                // panel left open on the pre-rewrite text/issues goes stale with
                // no error and no visual change (same contract as `emit_after_action`'s
                // other callers).
                live::emit_after_action(&app);
            }
            // Unlike `hotkey_check`'s failures (handled inside `dispatch_check`),
            // nothing else surfaces a rewrite failure — without this, a bad
            // endpoint/HTTP error/unreachable backend makes Ctrl+Alt+R silently
            // do nothing, forever.
            Err(e) => {
                eprintln!("scribe: rewrite failed for Ctrl+Alt+R: {e}");
                live::emit_nib_state(&app, "error", 0);
                // Same reasoning as `hotkey_check`: get-or-create + show the
                // panel so the error is visible even with `scribeNib` off,
                // where the nib (and whatever was showing its state) was
                // never created (finding 3).
                if let Err(e) = show_panel(&app) {
                    eprintln!("scribe: couldn't show the panel for a failed rewrite: {e}");
                }
            }
        }
    });
}

/// Ctrl+Alt+R and the tray's "Rewrite text": rewrite in the configured style.
pub fn hotkey_rewrite(app: &AppHandle) {
    rewrite_with(app, None);
}

/// The panel's style picker. Returns as soon as the work is handed to a
/// thread — progress and failure reach the panel through `nib_state` /
/// `panel_data` exactly as they do for the hotkey, which is what keeps this
/// visible with `scribeNib` off.
#[tauri::command]
pub fn scribe_rewrite(app: AppHandle, style: String) -> Result<(), String> {
    // Trust boundary: this string goes straight onto the wire. The UI only
    // ever sends one of these, so anything else is a bug worth failing loudly
    // rather than forwarding to the endpoint.
    if !REWRITE_STYLES.contains(&style.as_str()) {
        return Err(format!("unknown rewrite style {style:?}"));
    }
    rewrite_with(&app, Some(style));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both tests mutate the process-global `SESSION`; serialize them so one
    /// running under cargo's parallel harness can't stomp the other's state.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// `scribe_rewrite` rejects anything outside this set, and `rewrite_with`
    /// falls back to "formal" — so a list that drifted from the endpoint's
    /// contract would reject the UI's own values, or send a UI label as one.
    #[test]
    fn rewrite_styles_are_wire_values_not_labels() {
        assert!(
            REWRITE_STYLES.iter().all(|s| s.chars().all(|c| c.is_ascii_lowercase())),
            "labels like \"L33t\" must never reach the wire: {REWRITE_STYLES:?}"
        );
        assert!(
            REWRITE_STYLES.contains(&"formal"),
            "rewrite_with's fallback must itself be an accepted style"
        );
    }

    fn issue(offset: usize) -> Issue {
        Issue {
            offset,
            length: 3,
            message: "test".into(),
            replacements: vec!["fix".into()],
            kind: "grammar".into(),
        }
    }

    /// The whole point of the generation counter: a click on a panel row that
    /// was rendered before the user kept typing must not edit the new text.
    #[test]
    fn stale_generations_are_refused() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // bump_session is a no-op with no session installed (finding 4) — a
        // real one has to exist first for this to prove anything.
        set_session(None, 1, 1, "notepad.exe".into(), "hello".into(), vec![]);
        let g0 = session_gen();
        bump_session();
        assert_ne!(session_gen(), g0, "mutating the session must bump gen");
        assert!(!gen_is_current(g0), "the old generation must go stale");
        assert!(gen_is_current(session_gen()));
    }

    /// The guard the gen counter exists for: a stale gen passed to
    /// `dismiss_issue` must be refused outright, only the current gen may
    /// mutate the session.
    #[test]
    fn dismiss_issue_rejects_stale_gen() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let gen = set_session(
            None,
            2,
            2,
            "notepad.exe".into(),
            "hello world".into(),
            vec![issue(0), issue(6)],
        )
        .expect("unconditional install always succeeds");
        let stale = gen - 1;

        dismiss_issue(stale, 0);
        // Bind before asserting: a guard held inside assert_eq!'s scrutinee
        // outlives the panic and poisons SESSION for the sibling test.
        let stale_len = SESSION.lock().unwrap().as_ref().unwrap().issues.len();
        assert_eq!(stale_len, 2, "a stale gen must not touch the session");

        dismiss_issue(gen, 0);
        let (issues_len, new_gen) = {
            let guard = SESSION.lock().unwrap();
            let s = guard.as_ref().unwrap();
            (s.issues.len(), s.gen)
        };
        assert_eq!(issues_len, 1, "the current gen must remove the issue");
        // Not gen + 1: gens are drawn from a process-global counter, so the
        // guarantee is that it moved forward, not by how much.
        assert!(new_gen > gen, "a successful dismiss bumps gen");
    }
    // check_and_rewrite_shortcuts_are_parseable removed: subsumed by
    // `lib.rs`'s `hotkey_predicates_are_mutually_exclusive`, which parses both
    // constants and asserts single-predicate matching across all five
    // shortcuts (including these two).
}
