import { CalendarClock, Cpu, FolderOpen, Info, KeyRound, Mic, Search, Smartphone, Sparkles, SpellCheck, TerminalSquare, Tv, Volume2, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Page } from "../components/Layout";
import { WindowPicker } from "../components/MeetingRecorder";
import { ServerControls } from "../components/ServerControls";
import { Button, Card, ErrorState, IconButton, Loading, SectionTitle } from "../components/ui";
import { aiRequest, api, isTauri } from "../api";
import { PROVIDERS, providerMeta } from "../lib/ai";
import { oauthLogin, TWITCH_OAUTH, GOOGLE_OAUTH, GMAIL_OAUTH } from "../lib/oauth";
import { REWRITE_STYLES } from "../lib/scribe";
import { messageOf, notify, withToast } from "../lib/toast";
import { ensureNotifyPermission } from "../lib/notify";
import { speak } from "../lib/speech";
import { setApiKey, setModel, setSettings, toggleHiddenField, toggleHiddenTag, toggleScribeDisabledApp, useSettings, type AppSettings, type ProviderId } from "../lib/settings";
import { providerKeyId, keyRef, keyConfigured, secretRef, setSecret as vaultSet, deleteSecret as vaultDelete, useSecretPresence, loadSecretPresence } from "../lib/secrets";
import { connectedMailboxes, freeMailboxSlot, MAILBOX_IDS } from "../lib/packages";
import { codexOutDir, markCodexSynced } from "../lib/codexSync";
import { pushCloudSnapshotNow } from "../lib/cloudSync";
import { useAsync } from "../lib/useAsync";
import { formatCompact, formatCost, prettyModel, modelColor } from "../lib/format";
import { tokenTotal, type HaEntity } from "../types";

/** The live filter query plus a way for each card to report whether it
 *  survived it, so the page can tell "nothing matched" from "still loading"
 *  and say so. Context rather than props because the cards are spread across
 *  DesktopCard/ScribeCard/RemoteCard/... and threading a query through all of
 *  them would touch every signature. Empty query means show everything, which
 *  is the common case. */
const FilterQuery = createContext<{
  query: string;
  report: (id: string, visible: boolean) => void;
}>({ query: "", report: () => {} });

/** A settings card that hides itself when the filter doesn't match it.
 *
 *  Matches against the card's own rendered text rather than a hand-written
 *  keyword list. That means the filter searches exactly what you can see —
 *  field labels, help text, button captions — and it cannot go stale when a
 *  field is added, which a keyword list on every one of these cards would.
 *
 *  Every whitespace-separated word must match, so "asana token" finds the Deck
 *  card without the query having to be one literal substring.
 *
 *  Non-matching cards are hidden with CSS rather than unmounted: their text is
 *  what the next keystroke is matched against, and unmounting would also tear
 *  down the data each card loads. They are already all mounted today. */
function FilterCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { query: raw, report } = useContext(FilterQuery);
  const query = raw.trim().toLowerCase();
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const text = (ref.current?.textContent ?? "").toLowerCase();
    const hit = !query || query.split(/\s+/).every((w) => text.includes(w));
    setHidden(!hit);
    report(id, hit);
  }, [query, id, report]);

  // Stop counting toward the total once this card is gone, or a card that
  // unmounts while filtered out would keep the page on its empty state.
  useEffect(() => () => report(id, true), [id, report]);

  return (
    <div ref={ref} className={hidden ? "hidden" : undefined} aria-hidden={hidden}>
      <Card className={className}>{children}</Card>
    </div>
  );
}

export default function SettingsPage() {
  const settings = useSettings();
  const [filter, setFilter] = useState("");
  const [matches, setMatches] = useState<Record<string, boolean>>({});

  // Stable identity, and bails when nothing changed — a card reporting the
  // same result it reported last time must not trigger another render.
  const report = useCallback((id: string, visible: boolean) => {
    setMatches((prev) => (prev[id] === visible ? prev : { ...prev, [id]: visible }));
  }, []);
  const filterCtx = useMemo(() => ({ query: filter, report }), [filter, report]);
  const seen = Object.values(matches);
  const noMatches = filter.trim().length > 0 && seen.length > 0 && !seen.some(Boolean);
  const meta = providerMeta(settings.provider);
  const [connecting, setConnecting] = useState<"twitch" | "youtube" | "gmail" | null>(null);
  // Subscribe to the vault's presence map. Without this the mailbox chips below
  // are derived from state nothing re-renders on: removing a slot deleted the
  // credential but left the chip on screen, and only slot 1 appeared to work
  // because it also writes a settings field, which does trigger a render.
  useSecretPresence();
  // Re-reads on every render so the count reflects a just-finished connect.
  const gmailSlots = connectedMailboxes();
  const gmailCount = gmailSlots.length;

  /** Drop one linked mailbox. Clearing the vault entry is the whole job —
   *  `connectedMailboxes()` is derived from presence, not from settings. */
  async function removeMailbox(id: string) {
    try {
      await vaultSet(id, ""); // empty value deletes the credential
      await loadSecretPresence();
      if (id === MAILBOX_IDS[0]) setSettings({ gmailRefreshToken: "" });
      notify.success("Mailbox removed.");
    } catch (e) {
      notify.error(e);
    }
  }

  async function connectOAuth(which: "twitch" | "youtube" | "gmail") {
    try {
      setConnecting(which);
      if (which === "twitch") {
        if (!settings.twitchClientId || !keyConfigured("twitch-client-secret", settings.twitchClientSecret)) {
          throw new Error("Enter your Twitch client ID and secret first.");
        }
        const t = await oauthLogin(
          TWITCH_OAUTH,
          settings.twitchClientId,
          keyRef("twitch-client-secret", settings.twitchClientSecret)
        );
        await vaultSet("twitch-refresh-token", t.refresh_token); // vault, not settings
      } else {
        if (!settings.googleClientId || !keyConfigured("google-client-secret", settings.googleClientSecret)) {
          throw new Error("Enter your Google OAuth client ID and secret first.");
        }
        // Same OAuth client, independent grants — widening the YouTube token's
        // scope to cover Gmail would force a re-consent that kills it.
        const gmail = which === "gmail";
        // Each Gmail account lands in its own vault slot, so linking a second
        // mailbox doesn't overwrite the first.
        const slot = gmail ? freeMailboxSlot() : "youtube-refresh-token";
        if (!slot) {
          throw new Error(`All ${MAILBOX_IDS.length} Gmail slots are in use — remove one first.`);
        }
        const t = await oauthLogin(
          gmail ? GMAIL_OAUTH : GOOGLE_OAUTH,
          settings.googleClientId,
          keyRef("google-client-secret", settings.googleClientSecret)
        );
        if (!t.refresh_token) {
          throw new Error(
            "Google returned no refresh token. Remove cipherManager at myaccount.google.com/permissions, then reconnect."
          );
        }
        await vaultSet(slot, t.refresh_token);
        await loadSecretPresence(); // so the slot count updates without a reload
      }
      notify.success("Connected — stats will show on the Dashboard.");
    } catch (e) {
      notify.error(e);
    } finally {
      setConnecting(null);
    }
  }
  const { data, error, loading, reload } = useAsync(
    async () => {
      const [info, usage] = await Promise.all([api.getAppInfo(), api.getUsageStats()]);
      return { info, usage };
    },
    []
  );

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const { info, usage } = data;
  const locations = [
    { label: "Claude data root", path: info.claudeRoot, exists: info.rootExists },
    { label: "Projects directory", path: info.projectsDir, exists: info.rootExists },
    { label: "Archive directory", path: info.archiveDir, exists: true },
  ];

  return (
    <Page title="Settings" subtitle="Data locations, AI summaries, and reference pricing">
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter settings — try “token”, “voice”, “folder”"
          aria-label="Filter settings"
          className="w-full rounded-[10px] border border-outline bg-surface-2 py-2.5 pl-9 pr-3 font-body text-sm text-text placeholder:text-faint focus:border-cyan/60 focus:outline-none"
        />
      </div>

      {noMatches && (
        <div className="rounded-[10px] border border-dashed border-outline px-4 py-8 text-center">
          <p className="font-body text-sm text-muted">
            No settings match “{filter.trim()}”.
          </p>
          <Button variant="subtle" className="mt-3" onClick={() => setFilter("")}>
            Clear filter
          </Button>
        </div>
      )}

      <FilterQuery.Provider value={filterCtx}>
      {/* AI daily summaries */}
      <FilterCard className="mb-4 p-5">
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" /> AI daily summaries
          </span>
        </SectionTitle>
        <p className="mb-3 text-sm text-muted">
          Optional. Pick a provider and add a key to generate written recaps on the{" "}
          <span className="font-medium text-fg">Daily</span> page. Keys are stored locally in this
          app's OS credential store and sent directly to the provider when you summarize.
        </p>

        <label className="mb-1 block text-xs font-medium text-faint">Provider</label>
        <select
          value={settings.provider}
          onChange={(e) => setSettings({ provider: e.target.value as ProviderId })}
          className="mb-3 w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs font-medium text-faint">{meta.keyLabel}</label>
        <SecretField
          id={providerKeyId(settings.provider)}
          placeholder={meta.keyPlaceholder}
          legacy={settings.apiKeys[settings.provider]}
          onClearLegacy={() => setApiKey(settings.provider, "")}
        />

        {meta.needsBaseUrl && (
          <>
            <label className="mb-1 block text-xs font-medium text-faint">Base URL</label>
            <input
              type="text"
              value={settings.baseUrl}
              onChange={(e) => setSettings({ baseUrl: e.target.value })}
              placeholder="http://localhost:11434/v1"
              className="mb-3 w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </>
        )}

        <label className="mb-1 block text-xs font-medium text-faint">Model</label>
        <input
          type="text"
          value={settings.models[settings.provider]}
          onChange={(e) => setModel(settings.provider, e.target.value)}
          placeholder={meta.modelHint}
          className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />
        <p className="mt-1.5 text-[11px] text-faint">{meta.modelHint}</p>

        <label className="mt-5 flex cursor-pointer items-start gap-3 border-t border-outline pt-4">
          <input
            type="checkbox"
            checked={settings.notifications}
            onChange={async (e) => {
              if (e.target.checked) {
                const ok = await ensureNotifyPermission();
                setSettings({ notifications: ok });
                if (!ok) notify.error("Notification permission was denied");
              } else {
                setSettings({ notifications: false });
              }
            }}
            className="mt-0.5 h-4 w-4 accent-cyan"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">Desktop notifications</div>
            <div className="mt-0.5 font-body text-xs text-muted">
              Notify when a background AI task (batch summaries, the rundown) finishes while this
              window is hidden.
            </div>
          </div>
        </label>
      </FilterCard>

      {/* Creator stats (Twitch / YouTube) */}
      <FilterCard className="mb-4 p-5">
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <Tv className="h-3.5 w-3.5" /> Creator stats
          </span>
        </SectionTitle>
        <p className="mb-3 text-sm text-muted">
          Optional. Shows a channel-stats card on the Dashboard. YouTube needs a{" "}
          <span className="font-medium text-fg">Data API v3 key</span> (Google Cloud console, no
          OAuth). Twitch needs an application&apos;s{" "}
          <span className="font-medium text-fg">Client ID + Secret</span> from
          dev.twitch.tv/console. Credentials are stored locally and sent only to the platforms.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">YouTube API key</label>
            <SecretField
              id="youtube-api-key"
              placeholder="AIza…"
              legacy={settings.youtubeApiKey}
              onClearLegacy={() => setSettings({ youtubeApiKey: "" })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">
              YouTube channel (@handle or UC… id)
            </label>
            <input
              type="text"
              value={settings.youtubeChannel}
              onChange={(e) => setSettings({ youtubeChannel: e.target.value.trim() })}
              placeholder="@yourhandle"
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">Twitch client ID</label>
            <input
              type="text"
              value={settings.twitchClientId}
              onChange={(e) => setSettings({ twitchClientId: e.target.value.trim() })}
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">Twitch client secret</label>
            <SecretField
              id="twitch-client-secret"
              legacy={settings.twitchClientSecret}
              onClearLegacy={() => setSettings({ twitchClientSecret: "" })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">Twitch channel login</label>
            <input
              type="text"
              value={settings.twitchLogin}
              onChange={(e) => setSettings({ twitchLogin: e.target.value.trim() })}
              placeholder="your-channel"
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">
              Google OAuth client ID (Desktop)
            </label>
            <input
              type="text"
              value={settings.googleClientId}
              onChange={(e) => setSettings({ googleClientId: e.target.value.trim() })}
              placeholder="…apps.googleusercontent.com"
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">
              Google OAuth client secret
            </label>
            <SecretField
              id="google-client-secret"
              legacy={settings.googleClientSecret}
              onClearLegacy={() => setSettings({ googleClientSecret: "" })}
            />
          </div>
        </div>

        {/* OAuth connect — enables follower/sub counts (Twitch) and watch-time (YouTube). */}
        <div className="mt-4 border-t border-outline pt-4">
          <p className="mb-3 text-sm text-muted">
            For follower &amp; subscriber counts and YouTube watch-time, connect your accounts. This
            opens a browser sign-in once; only a refresh token is stored locally.
            {!isTauri() && (
              <span className="text-warn"> Available in the desktop app only.</span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => connectOAuth("twitch")}
              disabled={!isTauri() || connecting !== null}
              className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-accent disabled:opacity-50"
            >
              {connecting === "twitch"
                ? "Waiting for browser…"
                : settings.twitchRefreshToken
                  ? "✓ Twitch connected — reconnect"
                  : "Connect Twitch"}
            </button>
            <button
              onClick={() => connectOAuth("youtube")}
              disabled={!isTauri() || connecting !== null}
              className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-accent disabled:opacity-50"
            >
              {connecting === "youtube"
                ? "Waiting for browser…"
                : settings.youtubeRefreshToken
                  ? "✓ YouTube connected — reconnect"
                  : "Connect YouTube"}
            </button>
            <button
              onClick={() => connectOAuth("gmail")}
              disabled={!isTauri() || connecting !== null || !freeMailboxSlot()}
              title="Read-only Gmail access, used to find order and shipping mail for the Packages page. Link as many mailboxes as you like."
              className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-accent disabled:opacity-50"
            >
              {connecting === "gmail"
                ? "Waiting for browser…"
                : gmailCount === 0
                  ? "Connect Gmail (packages)"
                  : !freeMailboxSlot()
                    ? `✓ ${gmailCount} Gmail accounts (full)`
                    : `✓ ${gmailCount} Gmail — add another`}
            </button>
            {(settings.twitchRefreshToken ||
              settings.youtubeRefreshToken ||
              settings.gmailRefreshToken) && (
              <button
                onClick={() =>
                  setSettings({
                    twitchRefreshToken: "",
                    youtubeRefreshToken: "",
                    gmailRefreshToken: "",
                  })
                }
                disabled={connecting !== null}
                className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-warn hover:text-warn disabled:opacity-50"
              >
                Disconnect all
              </button>
            )}
          </div>
          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-1 text-sm font-medium text-fg">Proton Mail (packages)</div>
            <p className="mb-3 text-xs text-muted">
              Needs Proton Mail Bridge running and a paid Proton plan. Bridge only listens on
              loopback, so if it runs on another machine tunnel it rather than exposing it:{" "}
              <code className="text-faint">ssh -N -L 1143:127.0.0.1:1143 you@host</code> — the host
              below stays 127.0.0.1 either way.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <input
                type="text"
                value={settings.protonHost}
                onChange={(e) => setSettings({ protonHost: e.target.value.trim() })}
                placeholder="127.0.0.1"
                className="rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
              />
              <input
                type="number"
                value={settings.protonPort}
                onChange={(e) => setSettings({ protonPort: Number(e.target.value) || 1143 })}
                placeholder="1143"
                className="rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
              />
              <input
                type="text"
                value={settings.protonUser}
                onChange={(e) => setSettings({ protonUser: e.target.value.trim() })}
                placeholder="Bridge username"
                className="rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
              />
              <input
                type="text"
                value={settings.protonMailbox}
                onChange={(e) => setSettings({ protonMailbox: e.target.value })}
                placeholder="INBOX,Archive"
                title='Comma-separated IMAP folders. Avoid "All Mail" — Proton includes Trash and Spam in it.'
                className="rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
              />
            </div>
            <input
              type="password"
              value={settings.protonBridgePassword}
              onChange={(e) => setSettings({ protonBridgePassword: e.target.value })}
              onBlur={async (e) => {
                const raw = e.target.value.trim();
                if (!raw || raw.startsWith("{{secret:")) return;
                try {
                  await vaultSet("proton-bridge-password", raw);
                  await loadSecretPresence();
                  setSettings({ protonBridgePassword: "" }); // vault holds it now
                  notify.success("Bridge password stored in the vault.");
                } catch (err) {
                  notify.error(err);
                }
              }}
              placeholder={
                keyConfigured("proton-bridge-password", settings.protonBridgePassword)
                  ? "✓ Bridge password stored — type to replace"
                  : "Bridge password (from Bridge, not your Proton password)"
              }
              className="mt-2 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
            />
          </div>
          {gmailCount > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {gmailSlots.map((id, i) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-2 rounded-full border border-line bg-panel-2 px-3 py-1 font-mono text-[11px] text-muted"
                >
                  Mailbox {i + 1}
                  <button
                    onClick={() => void removeMailbox(id)}
                    title="Remove this mailbox"
                    className="text-faint transition-colors hover:text-warn"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </FilterCard>

      <G2Pairing />

      {/* CipherCodex reading notes */}
      <FilterCard className="mb-4 p-5">
        <h2 className="mb-1 font-display text-sm font-bold uppercase tracking-[1px] text-fg">
          CipherCodex reading notes
        </h2>
        <p className="mb-3 text-xs text-muted">
          Configure your CipherCodex WebDAV state directory to sync book highlights, notes,
          and recognized handwriting into the vault. The password for user <code>ccx</code>
          is stored in the OS credential store.
        </p>
        <label className="mb-3 block text-xs text-muted">
          WebDAV state URL (HTTPS)
          <input
            type="url"
            value={settings.ccxStateUrl}
            onChange={(e) => setSettings({ ccxStateUrl: e.target.value })}
            placeholder="https://sync.example.com/ccx/state/"
            className="mt-1 w-full rounded-lg border border-outline bg-bg px-3 py-2 text-sm text-text"
          />
        </label>
        <SecretField
          id="ccx-webdav-basic"
          placeholder="ccx WebDAV password"
          encode={(v) => btoa(`ccx:${v}`)}
        />
        <CodexSyncRow />
      </FilterCard>

      {/* Read-aloud (TTS) */}
      <FilterCard className="mb-4 p-5">
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <Volume2 className="h-3.5 w-3.5" /> Read-aloud voice
          </span>
        </SectionTitle>
        <p className="mb-3 text-sm text-muted">
          Voice used for read-aloud and the rundown. ElevenLabs is proxied through the app (no CORS
          issues); its key is stored locally.
        </p>

        <label className="mb-1 block text-xs font-medium text-faint">Engine</label>
        <select
          value={settings.ttsEngine}
          onChange={(e) => setSettings({ ttsEngine: e.target.value as "web" | "elevenlabs" })}
          className="mb-3 w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
        >
          <option value="web">Web Speech — local, built-in</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>

        {settings.ttsEngine === "elevenlabs" && (
          <>
            <label className="mb-1 block text-xs font-medium text-faint">ElevenLabs API key</label>
            <SecretField
              id="eleven-api-key"
              placeholder="sk_…"
              legacy={settings.elevenApiKey}
              onClearLegacy={() => setSettings({ elevenApiKey: "" })}
            />
            <label className="mb-1 block text-xs font-medium text-faint">Voice ID</label>
            <input
              type="text"
              value={settings.elevenVoiceId}
              onChange={(e) => setSettings({ elevenVoiceId: e.target.value.trim() })}
              placeholder="21m00Tcm4TlvDq8ikWAM"
              className="mb-3 w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
            <label className="mb-1 block text-xs font-medium text-faint">Model</label>
            <input
              type="text"
              value={settings.elevenModel}
              onChange={(e) => setSettings({ elevenModel: e.target.value.trim() })}
              placeholder="eleven_turbo_v2_5"
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
            <p className="mt-1.5 text-[11px] text-faint">
              Find voice IDs in your ElevenLabs dashboard. Models: eleven_turbo_v2_5 (fast),
              eleven_multilingual_v2 (quality).
            </p>
          </>
        )}

        <div className="mt-4">
          <Button
            variant="subtle"
            onClick={() => speak("tts-test", "This is your cipher Manager voice, reading aloud.")}
          >
            <Volume2 className="h-4 w-4" /> Test voice
          </Button>
        </div>
      </FilterCard>

      <WhisperxCard settings={settings} />
      <EmbeddingsCard settings={settings} />
      <VoiceCard settings={settings} />
      {isTauri() && <FilterCard className="mb-4"><ServerControls /></FilterCard>}
      {isTauri() && <RemoteCard />}

      {/* Deck — calendar + tasks */}
      <FilterCard className="mb-4 p-5">
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" /> Deck (calendar + tasks)
          </span>
        </SectionTitle>
        <p className="mb-3 text-sm text-muted">
          Powers the <span className="font-medium text-fg">Deck</span> page. Add a published calendar
          feed and/or an Asana token — it shows sample data until you do. Everything is stored locally.
        </p>

        <label className="mb-1 block text-xs font-medium text-faint">Your name (greeting)</label>
        <input
          type="text"
          value={settings.deckName}
          onChange={(e) => setSettings({ deckName: e.target.value })}
          placeholder="e.g. Alex"
          className="mb-3 w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />

        <label className="mb-1 block text-xs font-medium text-faint">
          Calendar feeds (ICS URLs — one per line)
        </label>
        <textarea
          value={settings.icsUrls.join("\n")}
          onChange={(e) =>
            setSettings({
              icsUrls: e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          rows={2}
          placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics"
          className="mb-3 w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent"
        />

        <label className="mb-1 block text-xs font-medium text-faint">Asana personal access token</label>
        <SecretField
          id="asana-token"
          placeholder="1/1234…"
          legacy={settings.asanaToken}
          onClearLegacy={() => setSettings({ asanaToken: "" })}
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">Project GID (optional)</label>
            <input
              type="text"
              value={settings.asanaProject}
              onChange={(e) => setSettings({ asanaProject: e.target.value.trim() })}
              placeholder="empty → My Tasks"
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-faint">Workspace GID (optional)</label>
            <input
              type="text"
              value={settings.asanaWorkspace}
              onChange={(e) => setSettings({ asanaWorkspace: e.target.value.trim() })}
              placeholder="auto"
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
            />
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          Just the token gets you "My Tasks" (including overdue). Set a project GID to pull one
          project instead.
        </p>

        <label className="mb-1 mt-3 block text-xs font-medium text-faint">
          Your name in Asana (optional)
        </label>
        <input
          type="text"
          value={settings.asanaMe}
          onChange={(e) => setSettings({ asanaMe: e.target.value })}
          placeholder="As it appears on tasks — enables the Mine filter on the Deck"
          className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-body text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />

        <label className="mt-4 flex cursor-pointer items-start gap-3 border-t border-outline pt-4">
          <input
            type="checkbox"
            checked={settings.asanaOpenInApp}
            onChange={(e) => setSettings({ asanaOpenInApp: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">
              Open tasks in the Asana desktop app
            </div>
            <div className="mt-0.5 font-body text-xs text-muted">
              Uses an <span className="font-mono">asanadesktop://</span> deep link (desktop app only).
              Turn off to open tasks in your browser instead.
            </div>
          </div>
        </label>

        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.meetingsOpenInApp}
            onChange={(e) => setSettings({ meetingsOpenInApp: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">
              Open meetings in desktop apps
            </div>
            <div className="mt-0.5 font-body text-xs text-muted">
              Join-call links open in Zoom (<span className="font-mono">zoommtg://</span>) or Teams
              (<span className="font-mono">msteams:</span>) when installed. Other links (e.g. Google
              Meet) always open in the browser.
            </div>
          </div>
        </label>

        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.meetingReminders}
            onChange={(e) => {
              setSettings({ meetingReminders: e.target.checked });
              if (e.target.checked) void ensureNotifyPermission();
            }}
            className="mt-0.5 h-4 w-4 accent-cyan"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">Meeting reminders</div>
            <div className="mt-0.5 font-body text-xs text-muted">
              Desktop notification about 2 minutes before each meeting starts, while the app is
              open. Click the notification to join.
            </div>
          </div>
        </label>

        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.autoRecordMeetings}
            onChange={(e) => setSettings({ autoRecordMeetings: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">Auto-record meetings</div>
            <div className="mt-0.5 font-body text-xs text-muted">
              Start the meeting recorder (mic + system audio) when a calendar meeting begins,
              while the app is open. If the meeting runs long it keeps recording until ~2 minutes
              of silence (capped 30 min past the scheduled end). The transcript note files into
              your vault automatically.
            </div>
          </div>
        </label>

        <label className="mt-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={settings.meetingScreenRec}
            onChange={(e) => setSettings({ meetingScreenRec: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">
              Record screen during meetings
            </div>
            <div className="mt-0.5 font-body text-xs text-muted">
              Pick a window; AI notes what's shown.
            </div>
          </div>
        </label>
        {isTauri() && <TestCapture />}

        <div className="mt-3 flex items-center gap-3">
          <input
            type="time"
            value={settings.digestTime}
            onChange={(e) => {
              setSettings({ digestTime: e.target.value });
              if (e.target.value) void ensureNotifyPermission();
            }}
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">Daily digest</div>
            <div className="mt-0.5 font-body text-xs text-muted">
              One desktop notification with the day's shape (meetings, due, overdue) at this time.
              Clear the field to turn it off.
            </div>
          </div>
        </div>

        <div className="mt-4 border-t border-outline pt-4">
          <label className="mb-1 block text-xs font-medium text-faint">Hidden tags</label>
          <p className="mb-2 font-body text-xs text-muted">
            Tasks carrying any of these tags are hidden from the Deck. Add tags here, or click a tag
            in a task's detail to hide it.
          </p>
          <HiddenListEditor
            items={settings.hiddenTags}
            onToggle={toggleHiddenTag}
            placeholder="Tag name, e.g. waiting"
            prefix="#"
          />
        </div>

        <div className="mt-4 border-t border-outline pt-4">
          <label className="mb-1 block text-xs font-medium text-faint">Hidden fields</label>
          <p className="mb-2 font-body text-xs text-muted">
            These custom fields are hidden from task cards on the Deck (they still show in a task's
            detail). Add names here, or click a field in a task's detail to hide it.
          </p>
          <HiddenListEditor
            items={settings.hiddenFields}
            onToggle={toggleHiddenField}
            placeholder="Field name, e.g. Priority"
          />
        </div>
      </FilterCard>

      {/* Acting mode — running skills */}
      <FilterCard className="mb-4 p-5">
        <SectionTitle>
          <span className="inline-flex items-center gap-1.5">
            <TerminalSquare className="h-3.5 w-3.5" /> Acting mode
          </span>
        </SectionTitle>
        <p className="mb-3 text-sm text-muted">
          Lets the <span className="font-medium text-fg">Skills</span> page run workflows by launching
          a real headless <span className="font-mono">claude -p</span> process. Off by default — nothing
          executes on your machine until you turn this on.
        </p>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-outline bg-panel-2 px-3.5 py-3">
          <input
            type="checkbox"
            checked={settings.actingMode}
            onChange={(e) => setSettings({ actingMode: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-cyan"
          />
          <div>
            <div className="font-body text-[13px] font-medium text-text">
              Enable running skills
            </div>
            <div className="mt-0.5 font-body text-xs text-muted">
              Each run shows the exact prompt and working directory before it starts, and streams its
              output into the Jobs panel.
            </div>
          </div>
        </label>

        {settings.actingMode && (
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-faint">Claude CLI binary</label>
              <input
                type="text"
                value={settings.claudeBin}
                onChange={(e) => setSettings({ claudeBin: e.target.value })}
                placeholder="claude"
                className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-faint">
                Working directory
              </label>
              <input
                type="text"
                value={settings.workDir}
                onChange={(e) => setSettings({ workDir: e.target.value })}
                placeholder={info.claudeRoot ?? "~/.claude"}
                className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
              />
              <p className="mt-1 text-[11px] text-faint">
                Defaults to your ~/.claude directory. Point it at a vault or project for skills that
                read/write files.
              </p>
              <label className="mb-1 mt-3 block text-xs font-medium text-faint">
                Vault folder (optional)
              </label>
              <input
                type="text"
                value={settings.vaultDir}
                onChange={(e) => setSettings({ vaultDir: e.target.value })}
                placeholder="e.g. D:\notes — browsed read-only on the Documents page"
                className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
              />
              <p className="mt-1 text-[11px] text-faint">
                A folder of markdown notes/reports (e.g. an Obsidian vault). Skill runs can write
                reports there; browse them under Documents → Vault.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-faint">
                Extra CLI args <span className="text-faint/70">(advanced)</span>
              </label>
              <input
                type="text"
                value={settings.claudeArgs}
                onChange={(e) => setSettings({ claudeArgs: e.target.value })}
                placeholder="--permission-mode acceptEdits"
                className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
              />
              <p className="mt-1 text-[11px] text-faint">
                Passed through to <span className="font-mono">claude -p</span>. Headless runs can't
                answer permission prompts, so set an allowed-tools or permission-mode flag if a skill
                needs tools.
              </p>
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-outline bg-panel-2 px-3.5 py-3">
              <input
                type="checkbox"
                checked={settings.memoryAutoPromote}
                onChange={(e) => setSettings({ memoryAutoPromote: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-cyan"
              />
              <div>
                <div className="font-body text-[13px] font-medium text-text">
                  Auto-promote harvested memory
                </div>
                <div className="mt-0.5 font-body text-xs text-muted">
                  Lets the nightly memory harvest write vault notes directly. Off (default): proposals wait
                  in the Memory Inbox on Documents for your review.
                </div>
              </div>
            </label>
          </div>
        )}
      </FilterCard>

      {/* Data locations */}
      <FilterCard className="mb-4 p-5">
        <SectionTitle>Data locations</SectionTitle>
        <div className="space-y-2">
          {locations.map((l) => (
            <div
              key={l.label}
              className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs text-faint">{l.label}</div>
                <div className="truncate font-mono text-sm text-fg">{l.path ?? "—"}</div>
              </div>
              {!l.exists && <span className="text-[11px] text-warn">not found</span>}
              {l.path && (
                <IconButton
                  title="Open in file explorer"
                  onClick={() => withToast(api.openPath(l.path!), { error: "Couldn't open location" })}
                >
                  <FolderOpen className="h-4 w-4" />
                </IconButton>
              )}
            </div>
          ))}
        </div>
        {!info.rootExists && (
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-xs text-warn">
            The ~/.claude directory wasn't found. Set the{" "}
            <span className="font-mono">CIPHER_CLAUDE_DIR</span> environment variable to point at it
            if it lives somewhere else.
          </div>
        )}
      </FilterCard>

      {/* Cost estimate — reference only, since most usage is on a subscription */}
      <FilterCard className="mb-4 p-5">
        <SectionTitle right={<span className="text-xs text-faint">reference only</span>}>
          Estimated cost
        </SectionTitle>
        <div className="mb-4 flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-fg">{formatCost(usage.totalCost)}</span>
          <span className="text-sm text-muted">if billed at API list prices</span>
        </div>
        <div className="space-y-1.5">
          {usage.byModel.map((m) => (
            <div key={m.model} className="flex items-center gap-2 text-sm">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: modelColor(m.model) }}
              />
              <span className="flex-1 truncate text-muted">{prettyModel(m.model)}</span>
              <span className="tabular-nums text-faint">{formatCompact(tokenTotal(m.tokens))} tok</span>
              <span className="w-20 text-right tabular-nums text-muted">{formatCost(m.costUsd)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-start gap-2 text-xs text-faint">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            You're on a Claude subscription, so you aren't billed per token — this is just a
            rough signal of where tokens go. Rates live in{" "}
            <span className="font-mono">src-tauri/src/pricing.rs</span>.
          </span>
        </div>
      </FilterCard>

      {isTauri() && <DesktopCard />}
      {isTauri() && <ScribeCard />}

      <FilterCard className="p-5">
        <SectionTitle>About</SectionTitle>
        <div className="text-sm text-muted">
          <div className="mb-1 font-mono text-base font-semibold text-fg">cipherManager v0.1.0</div>
          <p className="max-w-2xl leading-relaxed">
            A dashboard for all your Claude Code projects — usage analytics, transcript browsing,
            full-text search, daily recaps, and disk cleanup. Runs as a desktop app or a local web
            server; all data is read locally from{" "}
            <span className="font-mono">~/.claude</span>.
          </p>
          <div className="mt-3">
            <Button variant="subtle" onClick={reload}>
              Reload
            </Button>
          </div>
        </div>
      </FilterCard>
      </FilterQuery.Provider>
    </Page>
  );
}

function DesktopCard() {
  const { data, reload } = useAsync(() => api.getAutostart(), []);
  const settings = useSettings();

  return (
    <FilterCard className="mb-4 p-5">
      <SectionTitle>Desktop</SectionTitle>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={!!data}
          onChange={(e) =>
            withToast(api.setAutostart(e.target.checked).then(reload), {
              error: "Couldn't update autostart",
            })
          }
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <div>
          <div className="font-body text-[13px] font-medium text-text">Launch at login</div>
          <div className="mt-0.5 font-body text-xs text-muted">
            Starts cipherManager when you sign in to Windows, so reminders and automations are
            always running. Closing the window hides to the system tray; use the tray's Quit to
            exit.
          </div>
        </div>
      </label>

      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.paletteHotkey}
          onChange={(e) => setSettings({ paletteHotkey: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <div>
          <div className="font-body text-[13px] font-medium text-text">
            Global search hotkey (Ctrl+Alt+Space)
          </div>
          <div className="mt-0.5 font-body text-xs text-muted">
            Summons the universal-search window from any app — sessions, vault notes, projects,
            documents, local files and installed apps in one list. Turn this off if another
            launcher already owns the combination.
          </div>
        </div>
      </label>

      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.shotHotkey}
          onChange={(e) => setSettings({ shotHotkey: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <div>
          <div className="font-body text-[13px] font-medium text-text">
            Screenshot hotkey (Ctrl+Alt+S)
          </div>
          <div className="mt-0.5 font-body text-xs text-muted">
            Drag a region from anywhere; the capture lands on your clipboard and in the
            Screenshots folder.
          </div>
        </div>
      </label>
    </FilterCard>
  );
}

function HiddenListEditor({
  items,
  onToggle,
  placeholder,
  prefix = "",
}: {
  items: string[];
  onToggle: (value: string) => void;
  placeholder: string;
  prefix?: string;
}) {
  const [text, setText] = useState("");

  function add() {
    const t = text.trim();
    if (!t) return;
    if (!items.some((x) => x.toLowerCase() === t.toLowerCase())) onToggle(t);
    setText("");
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />
        <Button variant="subtle" onClick={add} disabled={!text.trim()}>
          Hide
        </Button>
      </div>
      {items.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <button
              key={item}
              onClick={() => onToggle(item)}
              title="Unhide"
              className="inline-flex items-center gap-1 rounded-full border border-violet/40 px-2.5 py-1 font-mono text-[11px] text-violet transition-colors hover:bg-violet/10"
            >
              {prefix}
              {item}
              <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** System-wide grammar checking + AI rewrite (CipherScribe fold-in): live
 * docking nib, Ctrl+Alt+G/R global hotkeys, and the tray's Check/Rewrite
 * text entries all read this config. Rust never reads settings, so
 * `ScribeRunner` (App.tsx) is what actually pushes this to the backend —
 * this card only edits the settings it watches. */
function ScribeCard() {
  const settings = useSettings();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [testFailed, setTestFailed] = useState(false);

  async function test() {
    setTesting(true);
    setTestResult("");
    setTestFailed(false);
    try {
      const result = await api.scribePing(
        settings.scribeEndpoint,
        secretRef("scribe-token"),
        settings.scribeLanguage
      );
      setTestResult(result);
      notify.success(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestResult(msg);
      setTestFailed(true);
      notify.error(`Test failed: ${msg}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <FilterCard className="mb-4 p-5">
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <SpellCheck className="h-3.5 w-3.5" /> Scribe
        </span>
      </SectionTitle>
      <p className="mb-3 text-sm text-muted">
        System-wide grammar checking and AI rewrite, folded in from the standalone CipherScribe tray
        app. Runs against your own LanguageTool + rewrite endpoint.
      </p>

      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-faint">Endpoint</label>
        <input
          type="text"
          value={settings.scribeEndpoint}
          onChange={(e) => setSettings({ scribeEndpoint: e.target.value })}
          placeholder="https://scribe.example.com"
          className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />
      </div>

      <div className="mb-3">
        <label className="mb-1 block text-xs font-medium text-faint">Token</label>
        <SecretField id="scribe-token" placeholder="Bearer token" />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-faint">Language</label>
          <input
            type="text"
            value={settings.scribeLanguage}
            onChange={(e) => setSettings({ scribeLanguage: e.target.value })}
            placeholder="en-US"
            className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-faint">
            Rewrite style (Ctrl+Alt+R)
          </label>
          <select
            value={settings.scribeRewriteStyle}
            onChange={(e) =>
              setSettings({ scribeRewriteStyle: e.target.value as AppSettings["scribeRewriteStyle"] })
            }
            className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-accent"
          >
            {REWRITE_STYLES.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.scribeNib}
          onChange={(e) => setSettings({ scribeNib: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <div>
          <div className="font-body text-[13px] font-medium text-text">Live docking nib</div>
          <div className="mt-0.5 font-body text-xs text-muted">
            Follows the focused text field anywhere on the desktop and checks it as you type.
          </div>
        </div>
      </label>

      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.scribeHotkeys}
          onChange={(e) => setSettings({ scribeHotkeys: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <div>
          <div className="font-body text-[13px] font-medium text-text">
            Global hotkeys (Ctrl+Alt+G check, Ctrl+Alt+R rewrite)
          </div>
          <div className="mt-0.5 font-body text-xs text-muted">
            On-demand check or AI rewrite of whatever's focused, from any app. The tray menu's Check
            text / Rewrite text items work either way.
          </div>
        </div>
      </label>

      <label className="mt-4 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.scribeIgnoreFullscreen}
          onChange={(e) => setSettings({ scribeIgnoreFullscreen: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <div>
          <div className="font-body text-[13px] font-medium text-text">
            Pause during fullscreen apps
          </div>
          <div className="mt-0.5 font-body text-xs text-muted">
            Skips live checking while a fullscreen app or game is in front.
          </div>
        </div>
      </label>

      <div className="mt-4 border-t border-outline pt-4">
        <label className="mb-1 block text-xs font-medium text-faint">Disabled apps</label>
        <p className="mb-2 font-body text-xs text-muted">
          Live checking is off for these apps (exe basename, e.g. notepad.exe). The panel's "Turn off
          for…" button adds here too.
        </p>
        <HiddenListEditor
          items={settings.scribeDisabledApps}
          onToggle={toggleScribeDisabledApp}
          placeholder="Exe name, e.g. notepad.exe"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-outline pt-4">
        <Button variant="subtle" onClick={() => void test()} disabled={testing}>
          {testing ? "Testing…" : "Test"}
        </Button>
        <span
          className={`text-xs ${testFailed ? "text-red-400" : testResult ? "text-emerald-400" : "text-muted"}`}
        >
          {testResult || "Round-trips a fixed sentence through the check endpoint."}
        </span>
      </div>
    </FilterCard>
  );
}

/** Semantic recall — embeddings endpoint for concept search over the vault.
 * Ollama (local GPU) or any OpenAI-compatible /v1/embeddings server. */
/** Remote access: serve health, outbound check (Bitdefender), phone pairing QR. */
/** A secret input backed by the OS credential store (WP-0B). Shows configured
 * state with Replace/Remove; never displays the stored value. */
/** Manual CipherCodex → vault sync (native; also runs quietly once a day). */
function CodexSyncRow() {
  const settings = useSettings();
  const present = useSecretPresence();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const vault = settings.vaultDir.trim();
  const stateUrl = settings.ccxStateUrl.trim();
  const ready = isTauri() && vault && stateUrl && present["ccx-webdav-basic"];

  async function run() {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const r = await api.codexSync(codexOutDir(vault), stateUrl);
      markCodexSynced();
      setStatus(
        `${r.books} book(s), ${r.notebooks} notebook(s) — ` +
          (r.written.length ? `${r.written.length} file(s) updated` : "all up to date") +
          (r.skipped ? ` (${r.skipped} without annotations skipped)` : "")
      );
    } catch (e) {
      setStatus((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button onClick={run} disabled={!ready || busy}>
        {busy ? "Syncing…" : "Sync now"}
      </Button>
      <span className="text-xs text-muted">
        {status ||
          (!vault
            ? "Set the vault folder (Documents section) to enable sync."
            : !stateUrl
              ? "Set the HTTPS WebDAV state URL above to enable sync."
            : !present["ccx-webdav-basic"]
              ? "Enter the ccx password above to enable sync."
              : "Writes reading notes into the vault's output/codex/. Also runs once a day.")}
      </span>
    </div>
  );
}

function SecretField({
  id,
  placeholder,
  legacy = "",
  onClearLegacy,
  encode,
}: {
  id: string;
  placeholder?: string;
  legacy?: string;
  onClearLegacy?: () => void;
  /** Transform the typed value before storing (e.g. wrap into a Basic-auth blob). */
  encode?: (v: string) => string;
}) {
  const presence = useSecretPresence();
  const configured = presence[id] === true || legacy.trim().length > 0;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");

  async function save() {
    const v = val.trim();
    if (!v) return;
    try {
      await vaultSet(id, encode ? encode(v) : v);
      onClearLegacy?.(); // drop any lingering plaintext copy
      setVal("");
      setEditing(false);
      notify.success("Saved to the credential store.");
    } catch (e) {
      notify.error(`Couldn't save: ${messageOf(e)}`);
    }
  }

  async function remove() {
    try {
      await vaultDelete(id);
      onClearLegacy?.();
      notify.success("Removed.");
    } catch (e) {
      notify.error(`Couldn't remove: ${messageOf(e)}`);
    }
  }

  if (configured && !editing) {
    return (
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-fg">
          <KeyRound className="h-4 w-4 text-emerald-400" /> Configured — stored securely
        </span>
        <Button variant="subtle" onClick={() => setEditing(true)}>
          Replace
        </Button>
        <Button variant="subtle" onClick={() => void remove()}>
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div className="relative mb-3 flex items-center gap-2">
      <div className="relative flex-1">
        <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        <input
          type="password"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder={placeholder}
          autoFocus={editing}
          className="w-full rounded-lg border border-line bg-panel-2 py-2.5 pl-9 pr-3 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
        />
      </div>
      <Button variant="subtle" onClick={() => void save()} disabled={!val.trim()}>
        Save
      </Button>
      {editing && (
        <Button variant="subtle" onClick={() => { setEditing(false); setVal(""); }}>
          Cancel
        </Button>
      )}
    </div>
  );
}

function RemoteCard() {
  const settings = useSettings();
  const [showQr, setShowQr] = useState(false);
  const inputCls =
    "w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent";
  const info = useAsync(() => api.remoteInfo(), []);
  const net = useAsync(async () => {
    // Ask the serve PROCESS whether it can reach the internet — its outbound
    // is what Bitdefender blocks, silently degrading the phone's deck.
    const r = await aiRequest("http://localhost:4600/api/net_check", {}, "", "GET");
    try {
      return JSON.parse(r.text) as { ok: boolean; error?: string };
    } catch {
      return { ok: false, error: `HTTP ${r.status}` };
    }
  }, []);

  const dot = (ok: boolean | undefined) => (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: ok === undefined ? "#666" : ok ? "#2dd4bf" : "#ef4444" }}
    />
  );

  return (
    <FilterCard className="mb-4 p-5">
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <Smartphone className="h-3.5 w-3.5" /> Remote access
        </span>
      </SectionTitle>
      <div className="mb-3 space-y-1.5 text-sm text-muted">
        <div className="flex items-center gap-2">
          {dot(info.data?.serveUp)} Web server on :4600 —{" "}
          {info.data ? (info.data.serveUp ? "running" : "not running") : "checking…"}
        </div>
        <div className="flex items-center gap-2">
          {dot(net.data?.ok)} Internet from the web server —{" "}
          {net.data
            ? net.data.ok
              ? "reachable (live calendar/Asana on the phone)"
              : "blocked — likely the Bitdefender firewall; the phone falls back to the desktop's cached deck"
            : "checking…"}
        </div>
        <div className="flex items-center gap-2">
          {dot(!!info.data?.tailscaleIp)} Tailscale —{" "}
          {info.data ? info.data.tailscaleIp ?? "not detected (URL below is localhost-only)" : "checking…"}
        </div>
      </div>
      {info.data && (
        <div className="mb-3 break-all rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs text-fg selectable">
          {info.data.url}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="subtle" onClick={() => setShowQr((v) => !v)} disabled={!info.data}>
          {showQr ? "Hide QR" : "Pair phone (QR)"}
        </Button>
        <Button
          variant="subtle"
          onClick={() =>
            void api.openUrl("https://github.com/mrzeappleGit/cipher-manager/releases/latest")
          }
        >
          Latest Android app
        </Button>
        <Button variant="subtle" onClick={() => { info.reload(); net.reload(); }}>
          Refresh
        </Button>
      </div>
      {showQr && info.data && (
        <div className="mt-3 inline-block rounded-lg bg-white p-2">
          <img
            alt="Pairing QR"
            width={200}
            height={200}
            src={`data:image/svg+xml;utf8,${encodeURIComponent(info.data.qrSvg)}`}
          />
        </div>
      )}
      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-2 text-sm text-fg">Phone push (ntfy)</div>
        <p className="mb-2 text-xs text-muted">
          Finished jobs and automations ping your phone. Install the ntfy app, subscribe to an
          unguessable topic, and put it here — the topic string is the secret. Blank = off.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-muted">Server</div>
            <input
              value={settings.ntfyServer}
              onChange={(e) => setSettings({ ntfyServer: e.target.value })}
              placeholder="https://ntfy.sh"
              className={inputCls}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Topic</div>
            <input
              value={settings.ntfyTopic}
              onChange={(e) => setSettings({ ntfyTopic: e.target.value })}
              placeholder="cipher-<something-random>"
              className={inputCls}
            />
          </div>
        </div>
        <Button
          variant="subtle"
          className="mt-2"
          disabled={!settings.ntfyTopic.trim()}
          onClick={() =>
            void import("../lib/ntfy").then((n) =>
              withToast(n.pushPhone("cipherManager", "Phone push is working."), {
                success: "Sent — check your phone.",
                error: "Push failed",
              })
            )
          }
        >
          Send test push
        </Button>
      </div>
      <div className="mt-4 space-y-2">
        <div className="text-sm font-medium text-text">Website publishing (desktop)</div>
        <p className="text-xs text-muted">
          Configure key authentication in your SSH config first. Uploads overwrite the selected files.
          Paths must be absolute and use letters, numbers, /, ., _, or - without dot segments.
        </p>
        <label className="block text-xs text-muted">
          SSH host or alias
          <input value={settings.sshHost} onChange={(e) => setSettings({ sshHost: e.target.value })}
            placeholder="user@server.example.com" className={inputCls} />
        </label>
        <label className="block text-xs text-muted">
          Schedule destination file
          <input value={settings.scheduleRemotePath} onChange={(e) => setSettings({ scheduleRemotePath: e.target.value })}
            placeholder="/srv/site/schedule.json" className={inputCls} />
        </label>
        <label className="block text-xs text-muted">
          Snapshot destination file
          <input value={settings.snapshotRemotePath} onChange={(e) => setSettings({ snapshotRemotePath: e.target.value })}
            placeholder="/srv/private/index.html" className={inputCls} />
        </label>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.cloudSyncEnabled}
          disabled={!settings.cloudSyncEnabled && (!isTauri() || !settings.sshHost.trim() || !settings.snapshotRemotePath.trim())}
          onChange={(e) => setSettings({ cloudSyncEnabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <div>
          <div className="font-body text-[13px] font-medium text-text">Cloud snapshot</div>
          <div className="mt-0.5 font-body text-xs text-muted">
            Uploads a read-only cache hourly and on quit so your phone can read it while this PC is off.
            The file includes private project history, calendar/tasks, and recent vault notes.
            Protect its URL with authentication on your server before enabling; the app does not add access control.
          </div>
        </div>
      </label>
      {isTauri() && settings.cloudSyncEnabled && (
        <div className="ml-7 mt-2">
          <button
            disabled={!settings.sshHost.trim() || !settings.snapshotRemotePath.trim()}
            onClick={() => void pushCloudSnapshotNow(true).catch(() => {})}
            className="rounded-full border border-outline px-3 py-1 font-mono text-[11px] text-muted transition-colors hover:border-cyan/60 hover:text-text"
          >
            push now
          </button>
        </div>
      )}
    </FilterCard>
  );
}

/** Wake-word voice assistant ("Cipher, …"). Ear runs in the desktop process. */
function VoiceCard({ settings }: { settings: AppSettings }) {
  const inputCls =
    "w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent";
  return (
    <FilterCard className="mb-4 p-5">
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <Mic className="h-3.5 w-3.5" /> Voice assistant (wake word)
        </span>
      </SectionTitle>
      <p className="mb-3 text-sm text-muted">
        Say the wake word, then a command: start recordings, run scripts, add to-dos, read the
        agenda, control Home Assistant — anything else becomes a Claude job. Needs a free{" "}
        <span className="font-mono text-xs">picovoice.ai</span> AccessKey; train a custom
        "Cipher" keyword on their console and point at the downloaded .ppn (blank = built-in
        "Computer"). Requires an ElevenLabs/OpenAI key for command transcription. Desktop only;
        pauses itself during meeting recordings.
      </p>
      <label className="mb-2 flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={settings.voiceEnabled}
          onChange={(e) => setSettings({ voiceEnabled: e.target.checked })}
        />
        Always listen while the app runs
      </label>
      <label className="mb-3 flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={settings.pttHotkey}
          onChange={(e) => setSettings({ pttHotkey: e.target.checked })}
        />
        Push-to-talk hotkey (Ctrl+Alt+C; the Stream Deck key works regardless)
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-muted">Picovoice AccessKey</div>
          <SecretField
            id="picovoice-key"
            placeholder="from console.picovoice.ai"
            legacy={settings.picovoiceKey}
            onClearLegacy={() => setSettings({ picovoiceKey: "" })}
          />
        </div>
        <div>
          <div className="mb-1 text-xs text-muted">Wake keyword file (.ppn)</div>
          <input
            value={settings.wakeKeywordPath}
            onChange={(e) => setSettings({ wakeKeywordPath: e.target.value })}
            placeholder='blank = built-in "Computer"'
            className={inputCls}
          />
        </div>
        <div>
          <div className="mb-1 text-xs text-muted">Home Assistant URL</div>
          <input
            value={settings.haUrl}
            onChange={(e) => setSettings({ haUrl: e.target.value })}
            placeholder="http://homeassistant.local:8123"
            className={inputCls}
          />
        </div>
        <div>
          <div className="mb-1 text-xs text-muted">Home Assistant token</div>
          <SecretField
            id="ha-token"
            placeholder="long-lived access token"
            legacy={settings.haToken}
            onClearLegacy={() => setSettings({ haToken: "" })}
          />
        </div>
        <HaEntityPicker settings={settings} />
      </div>
    </FilterCard>
  );
}

/** Home-card entity picker: fetch all HA states, tick what the Deck shows. */
function HaEntityPicker({ settings }: { settings: AppSettings }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<HaEntity[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>(settings.haEntities);
  const url = settings.haUrl.trim();

  async function load() {
    setOpen(true);
    setErr("");
    setAll(null);
    setPicked(settings.haEntities);
    try {
      setAll(await api.haStates(url, keyRef("ha-token", settings.haToken), []));
    } catch (e) {
      setErr(String((e as { message?: string })?.message ?? e));
    }
  }

  const GROUPS: [string, string[]][] = [
    ["Lights & switches", ["light", "switch"]],
    ["Scenes & scripts", ["scene", "script"]],
    ["Sensors", ["sensor", "binary_sensor"]],
  ];
  const ql = q.trim().toLowerCase();
  const match = (e: HaEntity) =>
    !ql || e.name.toLowerCase().includes(ql) || e.id.toLowerCase().includes(ql);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div>
      <div className="mb-1 text-xs text-muted">Deck Home card</div>
      <div className="flex items-center gap-2">
        <Button variant="subtle" onClick={() => void load()} disabled={!url}>
          Choose entities…
        </Button>
        <span className="text-xs text-faint">
          {settings.haEntities.length ? `${settings.haEntities.length} chosen` : "none chosen"}
        </span>
      </div>
      {open && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-line bg-panel p-4">
            <div className="mb-2 font-mono text-xs text-muted">Home card entities</div>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search…"
              className="mb-2 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {err && <div className="py-2 text-xs text-red-400">{err}</div>}
              {!all && !err && <div className="py-2 text-xs text-faint">loading…</div>}
              {all &&
                GROUPS.map(([label, domains]) => {
                  const rows = all.filter((e) => domains.includes(e.domain) && match(e));
                  if (!rows.length) return null;
                  return (
                    <div key={label} className="mb-2">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                        {label}
                      </div>
                      {rows.map((e) => (
                        <label
                          key={e.id}
                          className="flex cursor-pointer items-center gap-2 py-1 text-sm text-fg"
                        >
                          <input
                            type="checkbox"
                            checked={picked.includes(e.id)}
                            onChange={() => toggle(e.id)}
                          />
                          <span className="min-w-0 flex-1 truncate">{e.name}</span>
                          <span className="shrink-0 font-mono text-[10.5px] text-faint">{e.id}</span>
                        </label>
                      ))}
                    </div>
                  );
                })}
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                onClick={() => {
                  setSettings({ haEntities: picked });
                  setOpen(false);
                }}
              >
                Save
              </Button>
              <Button variant="subtle" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmbeddingsCard({ settings }: { settings: AppSettings }) {
  const inputCls =
    "w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent";
  const [indexing, setIndexing] = useState(false);
  const configured = settings.embeddingsUrl.trim() !== "" && settings.vaultDir.trim() !== "";

  async function buildIndex() {
    setIndexing(true);
    try {
      await api.semanticSearch(
        settings.vaultDir.trim(),
        settings.embeddingsUrl.trim(),
        settings.apiKeys[settings.provider] ?? "",
        settings.embeddingsModel.trim() || "nomic-embed-text",
        "", // empty query = just (re)build the index
        1
      );
      notify.success("Vault indexed — Ask now searches by meaning.");
    } catch (e) {
      notify.error(e);
    } finally {
      setIndexing(false);
    }
  }

  return (
    <FilterCard className="mb-4 p-5">
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" /> Semantic recall (embeddings)
        </span>
      </SectionTitle>
      <p className="mb-3 text-sm text-muted">
        Concept search over your vault for the Ask page — "how did we decide X?" finds notes that
        never use those words. Point at an OpenAI-compatible embeddings endpoint; Ollama on your
        GPU works great (<span className="font-mono text-xs">ollama pull nomic-embed-text</span>).
        Blank = keyword search only.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-faint">
            Embeddings base URL (blank = off)
          </label>
          <input
            type="text"
            value={settings.embeddingsUrl}
            onChange={(e) => setSettings({ embeddingsUrl: e.target.value })}
            placeholder="http://localhost:11434/v1"
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-faint">Model</label>
          <input
            type="text"
            value={settings.embeddingsModel}
            onChange={(e) => setSettings({ embeddingsModel: e.target.value })}
            placeholder="nomic-embed-text"
            className={inputCls}
          />
        </div>
      </div>
      {configured && (
        <div className="mt-3">
          <Button variant="subtle" onClick={() => void buildIndex()} disabled={indexing}>
            {indexing ? "Indexing vault…" : "Index vault now"}
          </Button>
        </div>
      )}
    </FilterCard>
  );
}

/** Local WhisperX (GPU) — meeting transcription on this machine's card.
 * The container starts for a transcription and stops after, so the GPU is
 * free for games the rest of the time; buttons here control it manually. */
function WhisperxCard({ settings }: { settings: AppSettings }) {
  const inputCls =
    "w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent";
  const [status, setStatus] = useState<"unknown" | "docker off" | "missing" | "stopped" | "running">("unknown");
  const [busy, setBusy] = useState(false);
  const name = settings.whisperxContainer.trim();
  const configured = settings.whisperxUrl.trim() !== "";

  async function refresh() {
    if (!name) return;
    try {
      const s = await api.dockerContainer(name, "status");
      setStatus(!s.daemonUp ? "docker off" : !s.exists ? "missing" : s.running ? "running" : "stopped");
    } catch {
      setStatus("unknown");
    }
  }
  useEffect(() => {
    if (configured) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, configured]);

  async function act(action: "start" | "stop") {
    setBusy(true);
    try {
      const s = await api.dockerContainer(name, action);
      setStatus(!s.daemonUp ? "docker off" : !s.exists ? "missing" : s.running ? "running" : "stopped");
      notify.success(action === "start" ? "WhisperX starting — model loads in ~a minute." : "WhisperX stopped, GPU freed.");
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }

  const dot =
    status === "running" ? "#22c55e" : status === "stopped" ? "#888" : status === "missing" ? "#f43f5e" : "#555";

  return (
    <FilterCard className="mb-4 p-5">
      <SectionTitle
        right={
          configured ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
              {status}
            </span>
          ) : undefined
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5" /> Local WhisperX (GPU)
        </span>
      </SectionTitle>
      <p className="mb-3 text-sm text-muted">
        Meeting transcription + diarization on your own GPU — free and private. When a URL is set it
        takes priority over cloud STT; the docker container auto-starts for each transcription and
        stops afterwards so the GPU stays free for games.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-faint">Service URL (blank = off)</label>
          <input
            type="text"
            value={settings.whisperxUrl}
            onChange={(e) => setSettings({ whisperxUrl: e.target.value })}
            placeholder="http://localhost:9000"
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-faint">Docker container</label>
          <input
            type="text"
            value={settings.whisperxContainer}
            onChange={(e) => setSettings({ whisperxContainer: e.target.value })}
            placeholder="whisperx-whisperx-1"
            className={inputCls}
          />
        </div>
      </div>
      {configured && (
        <div className="mt-3 flex gap-2">
          <Button variant="subtle" onClick={() => void act("start")} disabled={busy || status === "running"}>
            Start
          </Button>
          <Button variant="subtle" onClick={() => void act("stop")} disabled={busy || status !== "running"}>
            Stop
          </Button>
          <Button variant="subtle" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
        </div>
      )}
    </FilterCard>
  );
}

/** Even G2 glasses pairing: approve codes shown on the glasses, list/revoke
 * paired clients. Desktop-only — approval must stay on this machine. */
function G2Pairing() {
  const [pending, setPending] = useState<import("../types").G2Pending[]>([]);
  const [clients, setClients] = useState<import("../types").G2Client[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [p, c] = await Promise.all([api.g2PairPending(), api.g2Clients()]);
      setPending(p);
      setClients(c);
    } catch {
      /* not desktop */
    }
  }
  useEffect(() => {
    void refresh();
    const t = window.setInterval(refresh, 5000); // codes expire in 5 min
    return () => window.clearInterval(t);
  }, []);

  async function approve(code: string) {
    setBusy(true);
    try {
      await api.g2PairApprove(code);
      notify.success("G2 paired — the glasses will connect on their next poll.");
      await refresh();
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await api.g2Revoke(id);
      await refresh();
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(false);
    }
  }

  const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString() : "never");

  return (
    <FilterCard className="mb-4 p-5">
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <Smartphone className="h-3.5 w-3.5" /> Even G2 glasses
        </span>
      </SectionTitle>
      <p className="mb-3 text-sm text-muted">
        The G2 plugin gets a read-only HUD (agenda, tasks, usage, projects). Start pairing on the
        glasses, then approve the 6-digit code here. Tokens are scoped to the G2 API only.
        {!isTauri() && <span className="text-warn"> Approval works in the desktop app only.</span>}
      </p>
      {pending.length === 0 && clients.length === 0 && (
        <p className="text-sm text-faint">No pairing requests or paired glasses yet.</p>
      )}
      {pending.map((p) => (
        <div
          key={p.code}
          className="mb-2 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5"
        >
          <span className="font-mono text-lg tracking-widest text-fg">{p.code}</span>
          <span className="flex-1 truncate text-sm text-muted">{p.device}</span>
          <Button variant="subtle" onClick={() => void approve(p.code)} disabled={busy || !isTauri()}>
            Approve
          </Button>
        </div>
      ))}
      {clients.map((c) => (
        <div
          key={c.id}
          className="mb-2 flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5"
        >
          <span className="min-w-0 flex-1 truncate text-sm text-fg">
            {c.device} <span className="font-mono text-[11px] text-faint">({c.id})</span>
          </span>
          <span className="shrink-0 text-[11px] text-faint">last used {when(c.lastUsedMs)}</span>
          <Button variant="subtle" onClick={() => void revoke(c.id)} disabled={busy || !isTauri()}>
            Revoke
          </Button>
        </div>
      ))}
    </FilterCard>
  );
}

/** 5-second sample recording of a chosen window, then opens the mp4 — proves
 * capture works (e.g. GPU-composited Teams) before a real meeting depends on it. */
function TestCapture() {
  const [windows, setWindows] = useState<import("../types").CaptureWindow[] | null>(null);
  const [phase, setPhase] = useState<"idle" | "listing" | "recording" | "assembling">("idle");
  const [left, setLeft] = useState(0);

  async function begin() {
    setPhase("listing");
    try {
      const ws = await api.listCaptureWindows();
      if (!ws.length) {
        notify.error("No capturable windows found.");
        return;
      }
      setWindows(ws);
    } catch (e) {
      notify.error(`Couldn't list windows: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPhase("idle");
    }
  }

  async function pick(title: string | null) {
    setWindows(null);
    if (!title) return;
    try {
      setPhase("recording");
      await api.startScreenRecord(title);
      for (let i = 5; i > 0; i--) {
        setLeft(i);
        await new Promise((r) => setTimeout(r, 1000));
      }
      setPhase("assembling");
      const path = await api.stopScreenRecord();
      if (!path) throw new Error("capture produced no frames");
      notify.success(`Test clip saved — opening ${path}`);
      await api.openPath(path);
    } catch (e) {
      notify.error(`Test capture failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPhase("idle");
      setLeft(0);
    }
  }

  return (
    <div className="ml-7 mt-2">
      <button
        onClick={() => void begin()}
        disabled={phase !== "idle"}
        className="rounded-full border border-outline px-3 py-1 font-mono text-[11px] text-muted transition-colors hover:border-cyan/60 hover:text-text disabled:opacity-60"
      >
        {phase === "recording"
          ? `recording... ${left}`
          : phase === "assembling"
            ? "assembling..."
            : phase === "listing"
              ? "listing windows..."
              : "test video capture"}
      </button>
      {windows && <WindowPicker windows={windows} cancelLabel="Cancel" onPick={(t) => void pick(t)} />}
    </div>
  );
}
