import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SchedulePage from "./Schedule";

const push = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../api", () => ({ api: { pushScheduleSite: push } }));
vi.mock("../lib/settings", () => ({ getSettings: () => ({ sshHost: "publish", scheduleRemotePath: "/site/schedule.json" }) }));
vi.mock("../lib/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); push.mockClear(); vi.restoreAllMocks(); });

it("publishes only messages from the same-origin schedule frame", () => {
  // Keep an actual frame/source window without fetching the HTML from a server.
  const setAttribute = HTMLIFrameElement.prototype.setAttribute;
  vi.spyOn(HTMLIFrameElement.prototype, "setAttribute").mockImplementation(function (this: HTMLIFrameElement, name, value) {
    return setAttribute.call(this, name, name === "src" ? "about:blank" : value);
  });
  const { getByTitle } = render(<SchedulePage />);
  const source = (getByTitle("Schedule maker") as HTMLIFrameElement).contentWindow;
  expect(source).not.toBeNull();
  const data = { type: "cipher-push-schedule", json: "[]" };
  window.dispatchEvent(new MessageEvent("message", { data, source, origin: "https://untrusted.example" }));
  window.dispatchEvent(new MessageEvent("message", { data, source: window, origin: window.location.origin }));
  expect(push).not.toHaveBeenCalled();
  window.dispatchEvent(new MessageEvent("message", { data, source, origin: window.location.origin }));
  expect(push).toHaveBeenCalledExactlyOnceWith("[]", "publish", "/site/schedule.json");
});
