// Pure navigation reducer — every (route, gesture) pair has a deterministic
// result, tested in tests/nav.test.ts. Kept free of SDK imports on purpose.

import type { Gesture, Route } from "./types";

export const MENU = ["NOW", "BRIEF", "DECK", "PROJECTS", "STATUS", "PAIR", "EXIT"] as const;

export function reduce(r: Route, g: Gesture): Route | "exit" | "pair-start" {
  if (g === "double") {
    return r.name === "root" ? "exit" : { name: "root", sel: 0 };
  }
  switch (r.name) {
    case "root": {
      const n = MENU.length;
      if (g === "up") return { name: "root", sel: (r.sel + n - 1) % n };
      if (g === "down") return { name: "root", sel: (r.sel + 1) % n };
      // press
      switch (MENU[r.sel]) {
        case "NOW":
          return { name: "now" };
        case "BRIEF":
          return { name: "brief", page: 0 };
        case "DECK":
          return { name: "deck", page: 0 };
        case "PROJECTS":
          return { name: "projects" };
        case "STATUS":
          return { name: "status" };
        case "PAIR":
          return { name: "pair" };
        case "EXIT":
          return "exit";
      }
      return r;
    }
    case "brief":
      if (g === "up") return { name: "brief", page: Math.max(0, r.page - 1) };
      if (g === "down") return { name: "brief", page: r.page + 1 }; // renderer clamps
      return r;
    case "deck":
      if (g === "up") return { name: "deck", page: Math.max(0, r.page - 1) };
      if (g === "down") return { name: "deck", page: r.page + 1 };
      return r;
    case "pair":
      if (g === "press") return "pair-start";
      return r;
    default:
      // NOW / PROJECTS / STATUS: press refreshes (same route re-fetches).
      return r;
  }
}
