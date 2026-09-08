// cipherManager HUD for Even Realities G2 — read-only v1 (plan Phases 0-1).
// One full-canvas text container; swipe = move/page, press = open,
// double-press = back (at root: exit via the SDK confirmation).

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from "@evenrealities/even_hub_sdk";
import { api } from "./api";
import { age, clamp, menu, paginate } from "./display";
import { MENU, reduce } from "./nav";
import { getCache, getToken, initState, lastRoute, saveRoute, setCache } from "./state";
import type { BriefDto, DeckDto, Gesture, NowDto, ProjectsDto, Route } from "./types";

let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>;
let route: Route = { name: "root", sel: 0 };
let pairTimer: number | null = null;
let lastEvent = "(none yet)"; // shown on STATUS — hardware gesture debugging

function log(msg: string): void {
  const el = document.getElementById("log");
  if (el) el.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}\n${el.textContent ?? ""}`.slice(0, 4000);
}

// --- render -----------------------------------------------------------------

async function render(content: string): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: "main", content: clamp(content, 1900) })
  );
}

function offlineTag<T extends { ts: number }>(cached: T | null, fresh: boolean): string {
  if (fresh) return "";
  if (!cached) return " [OFFLINE]";
  return ` [OFFLINE ${age(cached.ts)}]`;
}

/** Fetch with cache-first display: cached content renders instantly, the
 * fresh copy re-renders when it lands, failures keep the cache + a tag. */
async function cached<T extends { ts: number }>(
  key: string,
  fetcher: () => Promise<T>,
  draw: (dto: T, tag: string) => string
): Promise<void> {
  const prior = getCache<T>(key);
  if (prior) await render(draw(prior, " [...]"));
  else await render("Loading...");
  try {
    const fresh = await fetcher();
    setCache(key, fresh);
    await render(draw(fresh, ""));
  } catch (e) {
    if ((e as Error).message === "UNPAIRED") {
      route = { name: "pair", error: "Not paired. Press to start pairing." };
      await show();
      return;
    }
    if (prior) await render(draw(prior, offlineTag(prior, false)));
    else await render(`CIPHER\n\nCan't reach cipherManager.\n${(e as Error).message}\n\nDouble-press: back`);
  }
}

async function show(): Promise<void> {
  saveRoute(route.name);
  switch (route.name) {
    case "root":
      return render(menu("CIPHER", [...MENU], route.sel));
    case "now":
      return cached<NowDto>("now", api.now, (d, tag) =>
        [
          `NOW${tag}`,
          "",
          d.event ? `> ${d.event}` : "> No more events today",
          `Tasks: ${d.overdue} overdue / ${d.dueToday} due today`,
          `Jobs running: ${d.runningJobs}`,
          `5h usage: ${d.usage5h}`,
          d.deckLive ? "" : "(deck data cached)",
        ].join("\n")
      );
    case "brief": {
      const page = route.page;
      return cached<BriefDto>("brief", api.brief, (d, tag) => {
        const pages = d.pages.length ? d.pages : ["(empty brief)"];
        const i = Math.min(page, pages.length - 1);
        const foot = pages.length > 1 ? `\n\n[${i + 1}/${pages.length}] swipe` : "";
        return `${pages[i]}${tag}${foot}`;
      });
    }
    case "deck": {
      const page = route.page;
      return cached<DeckDto>("deck", api.deck, (d, tag) => {
        const lines = [
          "EVENTS",
          ...(d.events.length ? d.events : ["(none today)"]),
          "",
          "TASKS",
          ...(d.tasks.length ? d.tasks : ["(none)"]),
        ];
        const pages = paginate(lines, `DECK${tag}`);
        return pages[Math.min(page, pages.length - 1)];
      });
    }
    case "projects":
      return cached<ProjectsDto>("projects", api.projects, (d, tag) =>
        [`PROJECTS${tag}`, "", ...(d.projects.length ? d.projects : ["(no recent activity)"])].join("\n")
      );
    case "status": {
      const paired = getToken() ? "paired" : "NOT PAIRED";
      await render(`STATUS\n\nChecking...\nToken: ${paired}`);
      try {
        const d = await api.now();
        return render(
          `STATUS\n\nServer: OK\nToken: ${paired}\nDeck: ${d.deckLive ? "live" : "cached"}\nSynced: ${age(d.ts)}\nLast event: ${lastEvent}`
        );
      } catch (e) {
        return render(`STATUS\n\nServer: ${(e as Error).message}\nToken: ${paired}\nLast event: ${lastEvent}\n\nDouble-press: back`);
      }
    }
    case "pair": {
      if (route.error) return render(`PAIR\n\n${route.error}`);
      if (!route.code) return render("PAIR\n\nPress to request a pairing code.\nApprove it in cipherManager\nSettings on your PC.");
      return render(`PAIR\n\nCode: ${route.code}\n\nApprove in cipherManager Settings.\nWaiting for approval...`);
    }
  }
}

// --- pairing flow -------------------------------------------------------------

function stopPairPolling(): void {
  if (pairTimer !== null) window.clearInterval(pairTimer);
  pairTimer = null;
}

async function startPairing(): Promise<void> {
  stopPairPolling();
  await render("PAIR\n\nRequesting a code...");
  try {
    const { code } = await api.pairStart("Even G2");
    route = { name: "pair", code };
    await show();
    pairTimer = window.setInterval(async () => {
      if (route.name !== "pair" || !route.code) return stopPairPolling();
      try {
        if (await api.pairPoll(route.code)) {
          stopPairPolling();
          route = { name: "root", sel: 0 };
          await render("PAIRED\n\nConnected to cipherManager.");
          window.setTimeout(() => void show(), 1200);
        }
      } catch (e) {
        stopPairPolling();
        route = { name: "pair", error: `${(e as Error).message}\n\nPress to retry.` };
        await show();
      }
    }, 3000);
  } catch (e) {
    route = { name: "pair", error: `${(e as Error).message}\n\nPress to retry.` };
    await show();
  }
}

// --- gesture dispatch (reducer lives in nav.ts) --------------------------------

async function onGesture(g: Gesture): Promise<void> {
  const next = reduce(route, g);
  if (next === "exit") {
    stopPairPolling();
    await bridge.shutDownPageContainer(1);
    return;
  }
  if (next === "pair-start") {
    await startPairing();
    return;
  }
  if (route.name !== "pair") stopPairPolling();
  route = next;
  await show();
}

// --- boot ---------------------------------------------------------------------

async function boot(): Promise<void> {
  bridge = await waitForEvenAppBridge();
  await initState(bridge as unknown as Parameters<typeof initState>[0]);

  await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 4,
          containerID: 1,
          containerName: "main",
          content: "CIPHER\n\nStarting...",
          isEventCapture: 1,
        }),
      ],
    })
  );

  bridge.onEvenHubEvent((event) => {
    // Hosts deliver eventType as a number, "CLICK_EVENT", or "CLICK" — the
    // SDK ships a normalizer for exactly this; raw switches miss strings.
    const t = event.textEvent ?? event.listEvent ?? event.jsonData;
    if (!t) return;
    const et = OsEventTypeList.fromJson((t as { eventType?: unknown }).eventType);
    lastEvent = `${String((t as { eventType?: unknown }).eventType)} -> ${et ?? "?"}`;
    switch (et) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
        void onGesture("up");
        break;
      case OsEventTypeList.SCROLL_BOTTOM_EVENT:
        void onGesture("down");
        break;
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        void onGesture("double");
        break;
      case OsEventTypeList.CLICK_EVENT:
      case undefined:
        void onGesture("press");
        break;
      default:
        break; // foreground/system/IMU events — not gestures
    }
  });

  // Restore the last route after an Android WebView reclaim — read screens
  // only; never restore into an action or mid-pairing state.
  const last = lastRoute();
  route =
    last === "now" || last === "projects" || last === "status"
      ? ({ name: last } as Route)
      : last === "brief" || last === "deck"
        ? ({ name: last, page: 0 } as Route)
        : { name: "root", sel: 0 };
  await show();
  log("ready");
}

void boot().catch((e) => log(`boot failed: ${e}`));
