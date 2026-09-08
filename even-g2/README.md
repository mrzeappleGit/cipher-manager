# cipherManager HUD for Even Realities G2

A glanceable, read-only remote for cipherManager on the G2 glasses (Even Hub
plugin). v1 scope per `ciphermanager-even-g2-plugin-plan.md`: pairing + NOW /
BRIEF / DECK / PROJECTS / STATUS screens with cached-offline behavior. No
microphone, no actions — those are later phases.

## How it connects

```
G2 gestures → Even app WebView (this plugin) → HTTPS → serve /api/g2/*
```

The `/api/g2/*` facade (in `src-tauri/src/bin/serve.rs` + `src-tauri/src/g2.rs`)
has its own scoped bearer tokens — a G2 token can never reach the general API.
Pairing: the glasses show a 6-digit code, you approve it in desktop Settings →
"Even G2 glasses". Tokens are stored hashed (sha256) on the host; revoke any
client from the same Settings card.

## Setup

1. `npm install`
2. Set `DEFAULT_ORIGIN` in `src/state.ts` to your own reachable HTTPS server
   and add that same origin to `app.json`'s network whitelist. It is empty by
   default; no pairing request is sent until configured. Keep the server on
   a private authenticated network (see the root security documentation).
3. `npm run build` → `dist/`
4. Simulator: `npm i -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator`,
   then preview per the Even docs. Device: QR sideload.
5. Package: `npm run pack` → `ciphermanager-g2.ehpk`

Verify CORS preflight, unauthorized responses, pairing and all four read
endpoints against your own server. The phone must be on the same private network.

`npm test` runs the navigation-reducer and pagination tests. `npm run check`
typechecks.

## Gesture contract

- Swipe up/down — move selection (root) or page (BRIEF/DECK)
- Press — open the selected screen; on PAIR, request/retry a code
- Double press — back; at root, exit (SDK confirmation)

## Phase 0 hardware checklist (pending — needs the real G2)

Per the plan, verify on hardware before calling v1 done, and record the
tested Even app / firmware / SDK / CLI / phone OS versions here:

- [ ] Root list renders; press, double-press, both swipes received
- [ ] G2 vs R1 event-source behavior confirmed
- [ ] `/api/g2/now` fetched through the intended HTTPS origin
- [ ] Phone locked 5 minutes → relaunch restores route safely
- [ ] Every screen readable while walking (indoors + outdoors)
- [ ] Revoking the client in Settings blocks the next request

Versions tested: _none yet_

## Later phases (not built)

Phase 2 (jobs/skills/recorder control) and Phase 3 (Ask + voice) per the plan;
both need the read-only HUD to prove itself on hardware first. The mic
permission (`g2-microphone`) is deliberately absent from `app.json` until then.
