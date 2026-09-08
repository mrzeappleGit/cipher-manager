import { lazy, Suspense, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, isTauri } from "./api";
import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { captureShot } from "./lib/shots";
import { notify } from "./lib/toast";
import { setClipChatEnabled } from "./lib/clipChat";
import { clipsConfigured } from "./lib/clips";
import { settingsReady, useSettings } from "./lib/settings";
import { DISABLE_APP_EVENT, disableAppInSettings } from "./lib/scribe";
import { loadSecretPresence, secretRef } from "./lib/secrets";
import { migrateProviderKeys } from "./lib/secretsMigrate";
import { Assistant } from "./components/Assistant";
import { RecordingPill } from "./components/MeetingRecorder";
import { VoicePill } from "./components/VoicePill";
import { ResultTrail } from "./components/ResultTrail";
import { DeckReminders } from "./components/DeckReminders";
import { AutomationRunner } from "./components/AutomationRunner";
import CloudSyncRunner from "./components/CloudSyncRunner";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import SessionView from "./pages/SessionView";
import SearchPage from "./pages/Search";
import Cleanup from "./pages/Cleanup";
import Daily from "./pages/Daily";
import DocumentsPage from "./pages/Documents";
import RoadmapPage from "./pages/Roadmap";
import BookmarksPage from "./pages/Bookmarks";
import AskPage from "./pages/Ask";
import SchedulePage from "./pages/Schedule";
import ScreenshotsPage from "./pages/Screenshots";

// The four largest routes load on demand — keeps the initial chunk small.
const DeckPage = lazy(() => import("./pages/Deck"));
const PackagesPage = lazy(() => import("./pages/Packages"));
const SettingsPage = lazy(() => import("./pages/Settings"));
const SkillsPage = lazy(() => import("./pages/Skills"));
const HighlightsPage = lazy(() => import("./pages/Highlights"));
// Lazy too: xterm.js only loads when the Agents page is opened.
const AgentsPage = lazy(() => import("./pages/Agents"));
// None of these three ever render inside the main window, so they stay out
// of its chunk.
const FinderSearch = lazy(() => import("./pages/FinderSearch"));
const ScribeNib = lazy(() => import("./pages/ScribeNib"));
const ScribePanel = lazy(() => import("./pages/ScribePanel"));

type WindowRole = "main" | "search" | "nib" | "panel";

/** Which window is this? Extra windows are separate Tauri windows identified
 *  by label; in a plain browser the #/<role> route stands in so each surface
 *  can be developed without building the desktop app. */
function windowRole(): WindowRole {
  const hash = window.location.hash;
  for (const r of ["search", "nib", "panel"] as const) {
    if (hash.startsWith(`#/${r}`)) return r;
  }
  if (!isTauri()) return "main";
  try {
    const label = getCurrentWindow().label;
    if (label === "search" || label === "nib" || label === "panel") return label;
  } catch {
    /* not a Tauri window */
  }
  return "main";
}

/** Main window only: the search panel hands routes over by event, because its
 *  results live in this window's router, not its own. */
function NavigateBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void listen<string>("cm-navigate", (e) => navigate(e.payload)).then((u) => (un = u));
    return () => un?.();
  }, [navigate]);
  return null;
}

/** Keeps the !clip chat listener in sync with its setting, app-wide. */
function ClipChatRunner() {
  const s = useSettings();
  useEffect(() => {
    setClipChatEnabled(s.clipChatCommand && clipsConfigured());
  }, [s.clipChatCommand]);
  return null;
}

/** The global hotkeys that need the frontend: Ctrl+Alt+S runs the region grab
 *  here (the target folder is a frontend setting Rust never reads), and
 *  Ctrl+Alt+Space opens the palette after Rust has raised the window. */
function HotkeyRunner() {
  const { shotHotkey, paletteHotkey, scribeHotkeys } = useSettings();

  // Surfaced, not swallowed: if another app already owns the combination the
  // toggle would otherwise read "on" while nothing ever happens.
  const claim = (key: string, p: Promise<void>) =>
    p.catch((e) => notify.error(`Couldn't claim ${key}: ${e instanceof Error ? e.message : e}`));

  useEffect(() => {
    void claim("Ctrl+Alt+S", api.setShotHotkey(shotHotkey));
  }, [shotHotkey]);

  useEffect(() => {
    void claim("Ctrl+Alt+Space", api.setPaletteHotkey(paletteHotkey));
  }, [paletteHotkey]);

  // Important here specifically: the standalone cipherScribe tray app may
  // still be running and holding these exact shortcuts, so a claim failure is
  // the expected way a user finds out they need to quit it (Task 11).
  useEffect(() => {
    void claim("Ctrl+Alt+G / Ctrl+Alt+R", api.setScribeHotkeys(scribeHotkeys));
  }, [scribeHotkeys]);

  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void listen("shot-hotkey", () => void captureShot("region")).then((u) => (un = u));
    return () => un?.();
  }, []);
  return null;
}

/** Keeps CipherScribe's live watcher in sync with its settings, and owns the
 *  one setting the panel window can't write for itself.
 *
 *  Rust never reads settings, so this is the only thing that starts or stops
 *  the watcher — and the watcher is what installs the system-wide keyboard
 *  hook, so leaving `scribeNib` off means neither ever exists. */
function ScribeRunner() {
  const {
    scribeNib,
    scribeEndpoint,
    scribeLanguage,
    scribeRewriteStyle,
    scribeIgnoreFullscreen,
    scribeDisabledApps,
  } = useSettings();

  // scribeDisabledApps is a fresh array on every settings write; join it so the
  // effect follows its contents rather than its identity.
  const disabledKey = scribeDisabledApps.join("\n");
  useEffect(() => {
    void api
      .scribeSetLive({
        enabled: scribeNib,
        endpoint: scribeEndpoint,
        token: secretRef("scribe-token"),
        language: scribeLanguage,
        style: scribeRewriteStyle,
        ignoreFullscreen: scribeIgnoreFullscreen,
        disabledApps: scribeDisabledApps,
      })
      .catch((e) => notify.error(`Couldn't start live checking: ${e instanceof Error ? e.message : e}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scribeNib, scribeEndpoint, scribeLanguage, scribeRewriteStyle, scribeIgnoreFullscreen, disabledKey]);

  // The panel's "Turn off for <exe>" runs in ITS webview, where a settings
  // write is invisible to this one (and would be clobbered by it). It emits
  // instead; the write happens here, which also re-runs the effect above.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void listen<string>(DISABLE_APP_EVENT, (e) => disableAppInSettings(e.payload)).then(
      (u) => (un = u)
    );
    return () => un?.();
  }, []);
  return null;
}

let mainBoot: Promise<boolean> | null = null;

export default function App() {
  // Extra windows are bare: no sidebar, no status bar, no router, and — this
  // is the part that matters — none of the global side-effect components
  // mounted below (DeckReminders' meeting reminders/digest/refresh,
  // AutomationRunner's ticker, …). This branch must return before any of
  // those mount, not merely render a different tree below them, or three
  // windows each end up running the same background jobs.
  const role = windowRole();
  if (role !== "main") {
    const View = { search: FinderSearch, nib: ScribeNib, panel: ScribePanel }[role];
    return (
      <Suspense fallback={<Loading label="Loading…" />}>
        <View />
      </Suspense>
    );
  }

  return <MainApp />;
}

function MainApp() {
  const [ready, setReady] = useState(false);
  const [automationsSafe, setAutomationsSafe] = useState(false);
  useEffect(() => {
    let alive = true;
    mainBoot ??= settingsReady.then(async () => {
      await loadSecretPresence();
      await migrateProviderKeys().catch((error) => notify.error(error));
      if (isTauri()) {
        try {
          const disabled = await invoke<string[]>("migrate_legacy_system_tasks");
          if (disabled.length) notify.info("Legacy system automations were disabled for safety. Recreate them in Skills.");
        } catch {
          notify.error("Couldn't disable legacy system tasks. In-app automation timers are paused; disable the old tasks in Windows Task Scheduler and restart.");
          return false;
        }
      }
      return true;
    }).catch((error) => {
      notify.error(`Startup checks failed; automation timers are paused: ${String(error)}`);
      return false;
    });
    void mainBoot.then((safe) => { if (alive) { setAutomationsSafe(safe); setReady(true); } });
    return () => { alive = false; };
  }, []);
  if (!ready) return <Loading label="Loading settings…" />;
  return (
    <Layout>
      <NavigateBridge />
      <DeckReminders />
      {automationsSafe && <AutomationRunner />}
      <CloudSyncRunner />
      <Assistant />
      <ClipChatRunner />
      <HotkeyRunner />
      <ScribeRunner />
      <RecordingPill />
      <VoicePill />
      <ResultTrail />
      <Suspense fallback={<Loading label="Loading…" />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/deck" element={<DeckPage />} />
        <Route path="/packages" element={<PackagesPage />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route
          path="/projects/:projectId/sessions/:sessionId"
          element={<SessionView />}
        />
        <Route path="/daily" element={<Daily />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/bookmarks" element={<BookmarksPage />} />
        <Route path="/ask" element={<AskPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/screenshots" element={<ScreenshotsPage />} />
        <Route path="/highlights" element={<HighlightsPage />} />
        <Route path="/cleanup" element={<Cleanup />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Layout>
  );
}
