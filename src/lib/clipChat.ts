// Twitch chat !clip command — a tiny IRC-over-WebSocket client (no tmi.js).
// Broadcaster and mods can type "!clip [label] [note…]" to fire a clip; the
// bot replies with the URL. Runs only while the app is open and the setting
// is on. ponytail: no viewer clipping / custom cooldown — flip the constants
// if the community ever needs them.

import { CLIP_LABELS, chatToken, createTwitchClip } from "./clips";

const COOLDOWN_MS = 30_000;

let ws: WebSocket | null = null;
let wanted = false;
let retryTimer: number | null = null;
let lastClipAt = 0;

function normalizeLabel(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return "Clip";
  return CLIP_LABELS.find((l) => l.toLowerCase().startsWith(s)) ?? "Clip";
}

/** Minimal IRC line parse: tags, prefix, command, params. */
function parseLine(line: string) {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    for (const kv of rest.slice(1, sp).split(";")) {
      const eq = kv.indexOf("=");
      if (eq > 0) tags[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = "";
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailingAt = rest.indexOf(" :");
  const trailing = trailingAt >= 0 ? rest.slice(trailingAt + 2) : "";
  const parts = (trailingAt >= 0 ? rest.slice(0, trailingAt) : rest).split(" ");
  return { tags, prefix, command: parts[0], params: parts.slice(1), trailing };
}

async function connect() {
  const { token, login } = await chatToken();
  const sock = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws = sock;

  sock.onopen = () => {
    sock.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    sock.send(`PASS oauth:${token}`);
    sock.send(`NICK ${login}`);
    sock.send(`JOIN #${login}`);
    console.log("[clipChat] connected to #" + login);
  };

  sock.onmessage = (ev) => {
    for (const line of String(ev.data).split("\r\n")) {
      if (!line) continue;
      const m = parseLine(line);
      if (m.command === "PING") {
        sock.send(`PONG :${m.trailing || "tmi.twitch.tv"}`);
        continue;
      }
      if (m.command !== "PRIVMSG") continue;
      const text = m.trailing.trim();
      if (!/^!clip(\s|$)/i.test(text)) continue;

      const user = (m.prefix.split("!")[0] || "").toLowerCase();
      const isBroadcaster = user === login;
      const isMod = m.tags.mod === "1" || (m.tags.badges ?? "").includes("moderator");
      if (!isBroadcaster && !isMod) continue;

      const now = Date.now();
      if (now - lastClipAt < COOLDOWN_MS) continue; // silent anti-spam
      lastClipAt = now;

      const args = text.split(/\s+/).slice(1);
      const label = normalizeLabel(args[0] ?? "");
      const who = m.tags["display-name"] || user;
      void createTwitchClip(label, `via chat by ${who}`, "chat")
        .then((entry) => sock.send(`PRIVMSG #${login} :🎬 Clip saved! (${entry.label}) ${entry.url}`))
        .catch((e) => {
          const reason = /offline/i.test(String(e?.message)) ? "stream looks offline" : "try again in a sec";
          sock.send(`PRIVMSG #${login} :⚠️ Couldn't save that clip — ${reason}.`);
        });
    }
  };

  sock.onclose = () => {
    ws = null;
    if (wanted && retryTimer === null) {
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (wanted) void connect().catch(() => {});
      }, 10_000);
    }
  };
  sock.onerror = () => sock.close();
}

/** Idempotent start/stop, driven by the settings toggle. */
export function setClipChatEnabled(on: boolean) {
  wanted = on;
  if (on && !ws) void connect().catch((e) => console.warn("[clipChat] " + e));
  if (!on) {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    ws?.close();
    ws = null;
  }
}
