// cipherManager Voice — Stream Deck plugin.
// keyDown → POST http://127.0.0.1:4671/trigger (the desktop app's loopback
// trigger server); a status poll drives the key state while visible:
// state 0 = idle/listening (title shows OFF when the ear isn't running),
// state 1 = capturing a command.

/* global WebSocket */
let ws = null;
const visible = new Map(); // context → true while the key is on screen
let pollTimer = null;

const BASE = "http://127.0.0.1:4671";

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function setState(context, state) {
  send({ event: "setState", context, payload: { state } });
}

function setTitle(context, title) {
  send({ event: "setTitle", context, payload: { title, target: 0 } });
}

async function poll() {
  if (visible.size === 0) return;
  let running = false;
  let phase = 0;
  try {
    const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(900) });
    const s = await r.json();
    running = !!s.running;
    phase = s.phase | 0;
  } catch {
    /* app not running */
  }
  for (const ctx of visible.keys()) {
    setState(ctx, phase === 2 ? 1 : 0);
    setTitle(ctx, running ? "" : "OFF");
  }
}

async function trigger(context) {
  try {
    const r = await fetch(`${BASE}/trigger`, { method: "POST", signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error();
    void poll();
  } catch {
    send({ event: "showAlert", context }); // yellow warning triangle on the key
  }
}

// Stream Deck calls this global with connection details.
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, inInfo) {
  ws = new WebSocket(`ws://127.0.0.1:${inPort}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ event: inRegisterEvent, uuid: inPluginUUID }));
    if (!pollTimer) pollTimer = setInterval(() => void poll(), 750);
  };
  ws.onmessage = (m) => {
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    const ctx = msg.context;
    switch (msg.event) {
      case "keyDown":
        void trigger(ctx);
        break;
      case "willAppear":
        visible.set(ctx, true);
        void poll();
        break;
      case "willDisappear":
        visible.delete(ctx);
        break;
    }
  };
}
