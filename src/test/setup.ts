import { vi } from "vitest";
// Pure-browser tests have no local server; individual API tests override this.
vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
