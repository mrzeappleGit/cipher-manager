pub mod agents;
pub mod brain;
pub mod ccx;
mod claude;
pub mod screenrec;
pub mod antigravity;
pub mod codex;
pub mod commands;
pub mod deck;
pub mod doctor;
pub mod g2;
pub mod inbox;
pub mod launcher;
pub mod ledger;
pub mod model;
mod parse;
pub mod proton;
mod pricing;
pub mod recorder;
pub mod scribe;
pub mod secrets;
pub mod service;
pub mod shot;
pub mod sizzle;
pub mod snapshot;
pub mod voice;

use commands::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The standalone universal-search window. Get-or-create: built on first use
/// rather than at startup (a second webview costs ~0.5s and a chunk of heap,
/// which nobody should pay for if they never open it), then kept alive and
/// merely hidden so every later press is instant. The frontend branches on the
/// "search" label to render the Finder window instead of the main app.
fn search_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window("search") {
        return Ok(w);
    }
    tauri::WebviewWindowBuilder::new(app, "search", tauri::WebviewUrl::App("index.html".into()))
        .title("Universal Search")
        .inner_size(940.0, 600.0)
        .min_inner_size(720.0, 420.0)
        // Our own title bar lives in the React tree (data-tauri-drag-region);
        // Windows chrome would look nothing like Finder either way.
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .center()
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_search_window(app: tauri::AppHandle) -> Result<(), String> {
    let w = search_window(&app)?;
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    // Tells the window to clear the field and re-focus it, so a second press
    // is a fresh search rather than the last one still on screen.
    let _ = app.emit_to("search", "search-window-shown", ());
    Ok(())
}

/// Open an in-app result: the panel's hits live in the main window's router,
/// so hide the panel, raise main, and hand it the route.
#[tauri::command]
fn open_in_main(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("search") {
        let _ = w.hide();
    }
    show_main(&app);
    app.emit_to("main", "cm-navigate", path).map_err(|e| e.to_string())
}

/// Spotlight-style: summon the universal-search window from anywhere. Same
/// Ctrl+Alt+_ family as push-to-talk and the region grab.
pub const PALETTE_SHORTCUT: &str = "ctrl+alt+space";

fn is_palette_shortcut(s: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    PALETTE_SHORTCUT
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map(|k| &k == s)
        .unwrap_or(false)
}

/// Follow the settings toggle: (un)register Ctrl+Alt+Space.
#[tauri::command]
fn set_palette_hotkey(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let registered = gs.is_registered(PALETTE_SHORTCUT);
    if enabled && !registered {
        gs.register(PALETTE_SHORTCUT).map_err(|e| e.to_string())
    } else if !enabled && registered {
        gs.unregister(PALETTE_SHORTCUT).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // Five global hotkeys share one handler:
        //   Ctrl+Alt+C — push-to-talk for the voice assistant (a Stream Deck
        //                "Hotkey" action sends this); skips the wake word.
        //   Ctrl+Alt+S — grab a screen region.
        //   Ctrl+Alt+Space — raise the window and open the command palette.
        //   Ctrl+Alt+G — Scribe: on-demand grammar check.
        //   Ctrl+Alt+R — Scribe: AI rewrite.
        // Registration is dynamic — the set_*_hotkey commands follow their
        // settings toggles, so only the enabled ones ever fire. Dispatch is
        // explicit and exhaustive: an unmatched shortcut does nothing, rather
        // than falling through to voice as the old catch-all `else` did — see
        // `tests::hotkey_predicates_are_mutually_exclusive` below.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    if shot::is_shot_shortcut(shortcut) {
                        shot::hotkey_pressed(app);
                    } else if is_palette_shortcut(shortcut) {
                        let _ = open_search_window(app.clone());
                    } else if scribe::is_check_shortcut(shortcut) {
                        scribe::hotkey_check(app);
                    } else if scribe::is_rewrite_shortcut(shortcut) {
                        scribe::hotkey_rewrite(app);
                    } else if voice::is_ptt_shortcut(shortcut) {
                        let _ = voice::trigger_capture(app);
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            // Tray icon: closing the window hides to tray so reminders and
            // automations keep running; Quit lives here. "Check text" /
            // "Rewrite text" mirror the standalone cipherScribe tray's own
            // menu (Check / Rewrite / Settings / Quit) — same entry points
            // (`scribe::hotkey_check`/`hotkey_rewrite`) the Ctrl+Alt+G/R
            // global hotkeys use, so they work even with those hotkeys off or
            // claimed by something else.
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let check_text = MenuItem::with_id(app, "check_text", "Check text", true, None::<&str>)?;
            let rewrite_text =
                MenuItem::with_id(app, "rewrite_text", "Rewrite text", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &check_text, &rewrite_text, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("cipherManager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "check_text" => scribe::hotkey_check(app),
                    "rewrite_text" => scribe::hotkey_rewrite(app),
                    "quit" => {
                        // Let the frontend push a final cloud snapshot first; a
                        // fallback thread hard-exits if it never calls exit_app.
                        let _ = app.emit_to("main", "quit-push", ());
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(20));
                            screenrec::shutdown_screen_rec();
                            handle.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            // Stream Deck plugin endpoint (loopback trigger + status).
            voice::start_trigger_server(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            service::local_server_status,
            service::local_server_start,
            service::local_server_stop,
            commands::migrate_legacy_system_tasks,
            commands::list_projects,
            commands::get_usage_stats,
            commands::refresh,
            commands::list_sessions,
            commands::get_session,
            commands::search,
            commands::search_any,
            commands::get_disk_stats,
            commands::get_daily_recaps,
            commands::get_recent_usage,
            commands::get_documents,
            commands::read_document_cmd,
            commands::get_recent_sessions,
            commands::get_skills,
            commands::write_skill,
            commands::write_vault_file,
            commands::save_deck_snapshot,
            commands::sync_vault_git,
            commands::push_schedule_site,
            snapshot::push_cloud_snapshot,
            commands::list_user_scripts,
            commands::run_user_script,
            commands::load_app_state,
            commands::save_app_state,
            commands::create_system_task,
            commands::delete_system_task,
            commands::set_system_task_enabled,
            commands::run_skill,
            commands::get_job,
            commands::list_jobs,
            commands::stop_job,
            commands::get_audit,
            commands::get_deck,
            commands::get_task_detail,
            commands::get_task_comments,
            commands::delete_session,
            commands::archive_session,
            commands::open_path,
            commands::reveal_path,
            commands::open_terminal,
            commands::list_vault,
            commands::read_vault_file,
            commands::get_autostart,
            commands::set_autostart,
            commands::open_in_editor,
            commands::open_url,
            commands::list_bookmarks,
            commands::open_in_brave,
            commands::pick_folder,
            commands::snapshot_url,
            commands::pick_snapshot_image,
            commands::reveal_session,
            commands::ai_proxy,
            commands::oauth_login,
            commands::proton_fetch_mail,
            commands::tts_proxy,
            commands::stt_proxy,
            commands::exit_app,
            commands::get_app_info,
            secrets::set_secret,
            secrets::delete_secret,
            secrets::secret_presence,
            commands::g2_pair_pending,
            commands::g2_pair_approve,
            commands::g2_clients,
            commands::g2_revoke,
            sizzle::detect_highlights,
            sizzle::start_sizzle,
            sizzle::list_clips,
            sizzle::sizzle_source,
            sizzle::recut_clip,
            sizzle::caption_clip,
            sizzle::make_compilation,
            recorder::start_recording,
            recorder::stop_recording,
            recorder::recording_status,
            recorder::transcribe_recording,
            recorder::transcribe_meeting,
            recorder::import_recording,
            recorder::pick_audio_file,
            recorder::docker_container,
            recorder::list_recordings,
            shot::capture_screenshot,
            shot::list_screenshots,
            shot::read_screenshot,
            shot::copy_screenshot,
            shot::delete_screenshot,
            shot::set_shot_hotkey,
            set_palette_hotkey,
            open_search_window,
            open_in_main,
            scribe::live::scribe_set_live,
            scribe::scribe_toggle_panel,
            scribe::scribe_hide_panel,
            scribe::scribe_apply_issue,
            scribe::scribe_apply_all,
            scribe::scribe_dismiss_issue,
            scribe::scribe_rewrite,
            scribe::set_scribe_hotkeys,
            scribe::net::scribe_ping,
            launcher::list_apps,
            launcher::search_files,
            screenrec::list_capture_windows,
            screenrec::start_screen_record,
            screenrec::stop_screen_record,
            screenrec::analyze_meeting_video,
            commands::ha_conversation,
            commands::ha_states,
            commands::ha_call_service,
            commands::remote_info,
            commands::get_serve_token,
            voice::start_voice,
            voice::stop_voice,
            voice::trigger_voice,
            voice::set_ptt_hotkey,
            voice::voice_status,
            brain::search_vault,
            doctor::vault_doctor,
            brain::semantic_search,
            brain::semantic_search_sessions,
            inbox::inbox_list,
            inbox::inbox_propose,
            inbox::inbox_decide,
            ccx::codex_sync,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // window-close hides to tray (see on_window_event above) rather than
            // exiting, so this only fires on a real process exit (tray Quit,
            // task kill, OS shutdown) — last-chance ffmpeg cleanup.
            if let tauri::RunEvent::Exit = event {
                screenrec::shutdown_screen_rec();
            }
        });
}

#[cfg(test)]
mod tests {
    /// The regression guard for the old `else -> voice` catch-all: with five
    /// global shortcuts sharing one handler (see `run()`'s `with_handler`),
    /// every predicate must match its own constant and nothing else's — and a
    /// shortcut none of the five own must match NONE of them, not silently
    /// fall through to voice as the removed `else` branch did.
    #[test]
    fn hotkey_predicates_are_mutually_exclusive() {
        use tauri_plugin_global_shortcut::Shortcut;

        let parse = |s: &str| -> Shortcut { s.parse().unwrap_or_else(|_| panic!("{s} must parse")) };
        let shortcuts = [
            parse(crate::voice::PTT_SHORTCUT),
            parse(crate::shot::SHOT_SHORTCUT),
            parse(super::PALETTE_SHORTCUT),
            parse(crate::scribe::CHECK_SHORTCUT),
            parse(crate::scribe::REWRITE_SHORTCUT),
        ];
        let predicates: [(&str, fn(&Shortcut) -> bool); 5] = [
            ("ptt", crate::voice::is_ptt_shortcut),
            ("shot", crate::shot::is_shot_shortcut),
            ("palette", super::is_palette_shortcut),
            ("check", crate::scribe::is_check_shortcut),
            ("rewrite", crate::scribe::is_rewrite_shortcut),
        ];

        for (owner_idx, owner) in shortcuts.iter().enumerate() {
            let matches: Vec<&str> = predicates
                .iter()
                .filter(|(_, f)| f(owner))
                .map(|(name, _)| *name)
                .collect();
            assert_eq!(
                matches,
                vec![predicates[owner_idx].0],
                "shortcut #{owner_idx} (expected predicate {:?}) matched {matches:?}, expected only its own predicate",
                predicates[owner_idx].0
            );
        }

        // A shortcut none of the five own must match none of them — exactly
        // the case the old catch-all `else` misrouted to the microphone.
        let unmatched = parse("ctrl+alt+z");
        assert!(
            predicates.iter().all(|(_, f)| !f(&unmatched)),
            "an unrecognised shortcut must match no predicate, not fall through to voice"
        );
    }

    /// Tauri's ACL is per-window: a capability that doesn't name a window
    /// leaves that window with *no* permissions, and the denials surface as
    /// rejected promises rather than anything visible. The search panel hides
    /// itself (Esc / ✕) and drags by its own title bar, and neither call is
    /// covered by `core:window:default` — that set is read-only queries. Both
    /// failures are silent, so they get a build-time guard instead. Loops over
    /// every extra window label this crate builds outside "main" (which
    /// `default.json` already covers) — this bug shipped once already, for
    /// "search" — checking presence for all of them and, for "search", the
    /// specific permissions its UI needs.
    #[test]
    fn every_extra_window_has_the_permissions_its_ui_needs() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        for (label, needs) in [
            (
                "search",
                vec![
                    "core:default",
                    "core:window:allow-hide",
                    "core:window:allow-start-dragging",
                ],
            ),
            // Both overlays RENDER from the events Rust pushes them
            // (nib_state / panel_data), and the panel's "Turn off for <exe>"
            // footer emits scribe-disable-app for the main window to persist —
            // settings are a per-webview cache, so the panel writing them
            // itself would be invisible to (and clobbered by) the main window.
            ("nib", vec!["core:event:allow-listen"]),
            ("panel", vec!["core:event:allow-listen", "core:event:allow-emit"]),
        ] {
            let mut granted: Vec<String> = vec![];
            let mut covered = false;
            for entry in std::fs::read_dir(&dir).expect("capabilities dir missing").flatten() {
                let raw = std::fs::read_to_string(entry.path()).unwrap_or_default();
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
                let names_label = v["windows"]
                    .as_array()
                    .map(|a| a.iter().any(|w| w.as_str() == Some(label)))
                    .unwrap_or(false);
                if !names_label {
                    continue;
                }
                covered = true;
                granted.extend(
                    v["permissions"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|p| p.as_str().map(str::to_string)),
                );
            }
            assert!(
                covered,
                "no capability lists the {label:?} window — it would launch with zero \
                 permissions and silently fail"
            );
            for need in needs {
                assert!(
                    granted.iter().any(|g| g == need),
                    "{label} window is missing {need} — granted: {granted:?}"
                );
            }
        }
    }
}
