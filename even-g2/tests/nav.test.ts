// Run with: npm test  (tsx + node:test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { MENU, reduce } from "../src/nav";
import { paginate } from "../src/display";
import type { Gesture, Route } from "../src/types";
import { api } from "../src/api";

test("unconfigured companion rejects before making a network request", async () => {
  await assert.rejects(api.now(), /Configure your server origin/);
});

test("every route/gesture pair has a deterministic result", () => {
  const routes: Route[] = [
    { name: "root", sel: 0 },
    { name: "root", sel: MENU.length - 1 },
    { name: "now" },
    { name: "brief", page: 0 },
    { name: "deck", page: 2 },
    { name: "projects" },
    { name: "status" },
    { name: "pair" },
  ];
  const gestures: Gesture[] = ["up", "down", "press", "double"];
  for (const r of routes) {
    for (const g of gestures) {
      const out = reduce(r, g);
      assert.ok(out !== undefined && out !== null, `${r.name}+${g}`);
    }
  }
});

test("double-press is back everywhere, exit at root", () => {
  assert.equal(reduce({ name: "root", sel: 3 }, "double"), "exit");
  assert.deepEqual(reduce({ name: "deck", page: 5 }, "double"), { name: "root", sel: 0 });
  assert.deepEqual(reduce({ name: "pair" }, "double"), { name: "root", sel: 0 });
});

test("root selection wraps both directions and opens the right screens", () => {
  assert.deepEqual(reduce({ name: "root", sel: 0 }, "up"), { name: "root", sel: MENU.length - 1 });
  assert.deepEqual(reduce({ name: "root", sel: MENU.length - 1 }, "down"), { name: "root", sel: 0 });
  assert.deepEqual(reduce({ name: "root", sel: MENU.indexOf("DECK") }, "press"), { name: "deck", page: 0 });
  assert.equal(reduce({ name: "root", sel: MENU.indexOf("EXIT") }, "press"), "exit");
  assert.equal(reduce({ name: "pair" }, "press"), "pair-start");
});

test("paging never goes negative", () => {
  assert.deepEqual(reduce({ name: "brief", page: 0 }, "up"), { name: "brief", page: 0 });
});

test("pagination keeps every line and respects the page budget", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `row ${i} ${"x".repeat(50)}`);
  const pages = paginate(lines, "TEST");
  assert.ok(pages.length > 1);
  for (const p of pages) assert.ok(p.length <= 400 + 20, `page too long: ${p.length}`); // +footer
  const joined = pages.join("\n");
  for (let i = 0; i < 40; i++) assert.ok(joined.includes(`row ${i} `), `lost row ${i}`);
});
