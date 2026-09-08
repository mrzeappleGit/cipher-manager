// Curated cloud vision models for Highlights/meeting analysis, plus the
// builder for the CloudVision wire arg (auth as {{secret:…}} placeholders).

import type { CloudVision } from "../types";
import type { AppSettings, ProviderId } from "./settings";
import { providerKeyConfigured, providerKeyRef } from "./secrets";

interface CloudModel {
  id: string;
  label: string;
  kind: "openai" | "anthropic";
  url: string;
  key: ProviderId;
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export const CLOUD_MODELS: CloudModel[] = [
  // Google retires versioned Gemini ids for new users (2.5-flash 404s as of
  // 2026-07) — the -latest aliases always point at the current generation.
  { id: "gemini-flash-latest", label: "Gemini Flash (~pennies/VOD)", kind: "openai", url: GEMINI_URL, key: "gemini" },
  { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite (cheapest)", kind: "openai", url: GEMINI_URL, key: "gemini" },
  { id: "gpt-4o-mini", label: "GPT-4o mini", kind: "openai", url: OPENAI_URL, key: "openai" },
  { id: "gpt-4o", label: "GPT-4o", kind: "openai", url: OPENAI_URL, key: "openai" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", kind: "anthropic", url: ANTHROPIC_URL, key: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", kind: "anthropic", url: ANTHROPIC_URL, key: "anthropic" },
];

function authHeaders(kind: "openai" | "anthropic", key: ProviderId, s: AppSettings): Record<string, string> {
  const ref = providerKeyRef(key, s.apiKeys[key] ?? "");
  return kind === "anthropic"
    ? { "x-api-key": ref, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${ref}` };
}

/** The CloudVision wire arg for the current settings. Throws a settings-page
 * pointer when the needed key isn't configured. */
export function cloudBackend(s: AppSettings): CloudVision {
  if (s.sizzleCloudModel === "custom") {
    const url = s.sizzleCloudUrl.trim();
    const model = s.sizzleCloudModelId.trim();
    if (!url || !model) throw new Error("Set the custom cloud URL and model id in the Highlights AI picker.");
    if (!providerKeyConfigured(s.sizzleCloudKey, s.apiKeys[s.sizzleCloudKey] ?? "")) {
      throw new Error(`Add your ${s.sizzleCloudKey} API key in Settings to use the custom cloud model.`);
    }
    return { kind: "openai", url, model, headers: authHeaders("openai", s.sizzleCloudKey, s) };
  }
  // ponytail: unknown stored id (e.g. a curated entry we later renamed, like
  // gemini-2.5-flash) silently falls back to the first entry — the current
  // default — rather than erroring a job over a stale dropdown value.
  const m = CLOUD_MODELS.find((m) => m.id === s.sizzleCloudModel) ?? CLOUD_MODELS[0];
  if (!providerKeyConfigured(m.key, s.apiKeys[m.key] ?? "")) {
    throw new Error(`Add your ${m.key} API key in Settings to use ${m.label}.`);
  }
  return { kind: m.kind, url: m.url, model: m.id, headers: authHeaders(m.kind, m.key, s) };
}
