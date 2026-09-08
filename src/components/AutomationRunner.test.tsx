import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ audit: vi.fn(), markRan: vi.fn(), items: [] as { id: string; name: string; lastRun: null }[] }));
vi.mock("../api", () => ({ isTauri: () => true, api: { getAudit: mocks.audit } }));
vi.mock("../lib/automations", () => ({
  automationsReady: Promise.resolve(), getAutomations: () => mocks.items, markRan: mocks.markRan,
  automationDue: () => false, runAutomation: vi.fn(),
}));
vi.mock("../lib/settings", () => ({ settingsReady: Promise.resolve(), getSettings: () => ({ actingMode: false }) }));
vi.mock("../lib/notify", () => ({ notifyDesktop: vi.fn() }));
import { AutomationRunner } from "./AutomationRunner";

it("ignores launch failures while preserving successful and actually launched failed runs", async () => {
  const outcomes = [
    { launched: false, status: "failed", exitCode: null },
    { status: "failed", exitCode: null },
    { status: "done", exitCode: 0 },
    { launched: true, status: "failed", exitCode: 1 },
    { status: "failed", exitCode: 1 },
  ];
  mocks.items = outcomes.map((_, i) => ({ id: `a${i}`, name: `Automation ${i}`, lastRun: null }));
  mocks.audit.mockResolvedValue(outcomes.map((outcome, i) => ({
    ...outcome, skill: "automation", label: mocks.items[i].name, startedAt: new Date().toISOString(),
  })));
  const view = render(<AutomationRunner />);
  try {
    await waitFor(() => expect(mocks.markRan).toHaveBeenCalledTimes(3));
    expect(mocks.markRan.mock.calls.map(([id]) => id)).toEqual(["a2", "a3", "a4"]);
  } finally { view.unmount(); }
});
