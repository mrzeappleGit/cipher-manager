import { aiRequest } from "../api";
import { keyConfigured, keyRef, providerKeyConfigured, providerKeyRef } from "./secrets";
import type { DayRecap } from "../types";
import { getSettings, type AppSettings, type ProviderId } from "./settings";

interface CompleteArgs {
  key: string;
  model: string;
  prompt: string;
  baseUrl: string;
  maxTokens: number;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  keyLabel: string;
  keyPlaceholder: string;
  modelHint: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    needsKey: true,
    needsBaseUrl: false,
    keyLabel: "Anthropic API key",
    keyPlaceholder: "sk-ant-…",
    modelHint: "e.g. claude-haiku-4-5-20251001, claude-sonnet-4-5, claude-opus-4-8",
  },
  {
    id: "openai",
    label: "OpenAI",
    needsKey: true,
    needsBaseUrl: false,
    keyLabel: "OpenAI API key",
    keyPlaceholder: "sk-…",
    modelHint: "e.g. gpt-4o-mini, gpt-4o",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    needsKey: true,
    needsBaseUrl: false,
    keyLabel: "Google AI API key",
    keyPlaceholder: "AIza…",
    modelHint: "e.g. gemini-2.0-flash, gemini-1.5-pro",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible (Ollama, LM Studio, OpenRouter…)",
    needsKey: false,
    needsBaseUrl: true,
    keyLabel: "API key (optional)",
    keyPlaceholder: "blank for local servers",
    modelHint: "e.g. llama3.1, qwen2.5, or any model your endpoint serves",
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Whether the currently-selected provider has what it needs to run. */
export function isProviderReady(s: AppSettings): boolean {
  const meta = providerMeta(s.provider);
  const hasKey = providerKeyConfigured(s.provider, s.apiKeys[s.provider] ?? "");
  const hasModel = (s.models[s.provider] ?? "").trim().length > 0;
  return hasModel && (!meta.needsKey || hasKey);
}

function buildPrompt(recap: DayRecap): string {
  const lines: string[] = [];
  for (const p of recap.projects) {
    lines.push(`Project "${p.name}" — ${p.sessionCount} session(s), ${p.messageCount} messages:`);
    for (const s of p.sessions) {
      lines.push(`  • ${s.title || s.firstPrompt || "untitled session"}`);
    }
  }
  return `You are writing a brief daily work recap for a developer, based on their Claude Code activity on ${recap.day}.

Here is what they worked on that day:

${lines.join("\n")}

Write a concise, friendly recap of 2–4 sentences describing what they accomplished. Focus on the projects and the concrete tasks. Do not mention token counts or costs. Address the reader as "you".`;
}

/** POST a JSON body to an AI provider (via the backend proxy) and parse JSON. */
async function chat(
  url: string,
  headers: Record<string, string>,
  bodyObj: unknown
): Promise<any> {
  const { status, text } = await aiRequest(url, headers, JSON.stringify(bodyObj));
  if (status < 200 || status >= 300) {
    let msg = `API error (${status})`;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.error?.type || j?.message || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid response from provider.");
  }
}

async function anthropicComplete({ key, model, prompt, maxTokens }: CompleteArgs): Promise<string> {
  const data = await chat(
    "https://api.anthropic.com/v1/messages",
    {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }
  );
  const blocks: Array<{ type: string; text?: string }> = data?.content ?? [];
  return (
    blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("\n")
      .trim() || "(No summary was returned.)"
  );
}

async function openaiComplete(
  baseUrl: string,
  { key, model, prompt, maxTokens }: CompleteArgs,
  requireKey: boolean,
  tokenField: "max_tokens" | "max_completion_tokens"
): Promise<string> {
  if (requireKey && !key) throw new Error("Add an API key in Settings.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  // Native OpenAI reasoning models (o1/o3/gpt-5) require max_completion_tokens;
  // legacy/openai-compatible servers (Ollama, LM Studio) expect max_tokens.
  const data = await chat(baseUrl.replace(/\/+$/, "") + "/chat/completions", headers, {
    model,
    messages: [{ role: "user", content: prompt }],
    [tokenField]: maxTokens,
  });
  return (data?.choices?.[0]?.message?.content ?? "").trim() || "(No summary was returned.)";
}

async function geminiComplete({ key, model, prompt, maxTokens }: CompleteArgs): Promise<string> {
  // Key rides in the x-goog-api-key header, not the URL — keeps secrets out of
  // query strings and lets the backend resolve the {{secret:…}} placeholder.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;
  const data = await chat(
    url,
    { "content-type": "application/json", "x-goog-api-key": key },
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }
  );
  const parts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts ?? [];
  return (
    parts
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n")
      .trim() || "(No summary was returned.)"
  );
}

/** Run an arbitrary prompt through the configured provider. */
export async function runPrompt(prompt: string, maxTokens = 400): Promise<string> {
  const s = getSettings();
  const meta = providerMeta(s.provider);
  // Placeholder when the key lives in the vault; raw legacy value otherwise.
  const key = providerKeyRef(s.provider, s.apiKeys[s.provider] ?? "");
  const model = (s.models[s.provider] ?? "").trim();

  if (meta.needsKey && !key) {
    throw new Error(`Add a ${meta.label} API key in Settings to use AI features.`);
  }
  if (!model) {
    throw new Error("Set a model in Settings.");
  }

  const args: CompleteArgs = { key, model, prompt, baseUrl: "", maxTokens };
  switch (s.provider) {
    case "anthropic":
      return anthropicComplete(args);
    case "openai":
      return openaiComplete("https://api.openai.com/v1", args, true, "max_completion_tokens");
    case "gemini":
      return geminiComplete(args);
    case "openai-compatible": {
      const baseUrl = s.baseUrl.trim() || "http://localhost:11434/v1";
      return openaiComplete(baseUrl, { ...args, baseUrl }, false, "max_tokens");
    }
    default:
      throw new Error("Unknown provider");
  }
}

/** Search the web via Anthropic's server-side web_search tool. Uses the vault
 * Anthropic key regardless of the selected provider (it's the search engine).
 * Returns the synthesized answer plus deduped source citations. */
export async function webSearch(
  query: string,
  maxTokens = 900
): Promise<{ text: string; sources: Array<{ title: string; url: string }> }> {
  const s = getSettings();
  const key = keyRef("anthropic-api-key", s.apiKeys.anthropic);
  if (!keyConfigured("anthropic-api-key", s.apiKeys.anthropic)) {
    throw new Error("Add an Anthropic API key in Settings to search the web.");
  }
  const model = (s.models.anthropic || "claude-haiku-4-5-20251001").trim();
  const data = await chat(
    "https://api.anthropic.com/v1/messages",
    {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }
  );
  const blocks: Array<{
    type: string;
    text?: string;
    citations?: Array<{ url?: string; title?: string }>;
  }> = data?.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("")
    .trim();
  const seen = new Set<string>();
  const sources: Array<{ title: string; url: string }> = [];
  for (const b of blocks) {
    for (const c of b.citations ?? []) {
      if (c.url && !seen.has(c.url)) {
        seen.add(c.url);
        sources.push({ title: c.title || c.url, url: c.url });
      }
    }
  }
  return { text: text || "(No answer was returned.)", sources };
}

/** Propose an improved SKILL.md based on how recent runs actually went. */
export async function improveSkill(
  skillMd: string,
  runs: Array<{ status: string; excerpt: string }>
): Promise<string> {
  const history = runs.length
    ? runs
        .map((r, i) => `--- run ${i + 1} (${r.status}) ---\n${r.excerpt}`)
        .join("\n\n")
    : "(no recorded runs)";
  const out = await runPrompt(
    `You improve Claude Code skill files. Below is a SKILL.md and output excerpts from its recent headless runs. Rewrite the skill to be clearer and more reliable: tighten vague steps, add guards for failures visible in the runs, keep the same frontmatter fields (update description only if inaccurate), keep the author's voice and formatting conventions. Change nothing that already works.

Return ONLY the complete new SKILL.md content — no commentary, no code fences.

Current SKILL.md:
${skillMd}

Recent runs:
${history}`,
    3000
  );
  // Strip accidental code fences.
  return out.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

/** Generate a short narrative recap of a day via the configured provider. */
export async function summarizeDay(recap: DayRecap): Promise<string> {
  return runPrompt(buildPrompt(recap));
}

/** Suggest the top things to focus on next, based on recent sessions. */
export async function suggestFocus(
  items: Array<{ projectName: string; title: string | null; firstPrompt: string | null }>
): Promise<string> {
  const lines = items.map((s) => `- ${s.projectName}: ${s.title || s.firstPrompt || "session"}`);
  const prompt = `You are a focused engineering assistant. Based on this developer's most recent Claude Code sessions, suggest the top 3 things to focus on next. Be concrete and brief — one short line each, imperative voice, no preamble.

Recent sessions:

${lines.join("\n")}`;
  return runPrompt(prompt);
}

/** Answer a question grounded in retrieved transcript excerpts (RAG). */
export async function answerWithContext(
  question: string,
  sources: Array<{ projectName: string; sessionTitle: string | null; snippet: string }>
): Promise<string> {
  const ctx = sources
    .map(
      (s, i) =>
        `[${i + 1}] (${s.projectName}${s.sessionTitle ? ` / ${s.sessionTitle}` : ""}) ${s.snippet}`
    )
    .join("\n\n");
  const prompt = `Answer the question using ONLY the excerpts below, drawn from the user's own notes (vault) and Claude Code transcripts. If they don't contain the answer, say you couldn't find it. Cite sources inline as [n].

Excerpts:
${ctx}

Question: ${question}

Answer concisely:`;
  return runPrompt(prompt);
}

/** Summarize the day's calendar + tasks for the Deck. */
export async function summarizeDeck(input: {
  dateLabel: string;
  events: Array<{ time: string; title: string; location: string; kind: string }>;
  overdue: string[];
  dueToday: string[];
  upcoming: string[];
  todos: string[];
  comments: string[];
}): Promise<string> {
  const agenda = input.events.length
    ? input.events
        .map((e) => `- ${e.time} ${e.title} (${e.kind.toLowerCase()}, ${e.location})`)
        .join("\n")
    : "- (nothing scheduled)";
  const fmt = (arr: string[]) => (arr.length ? arr.map((t) => `- ${t}`).join("\n") : "- (none)");

  const prompt = `You are the user's executive assistant. Give a brief, friendly summary of their day so they know what to expect and what matters most. Use the data below. Write 3–5 short sentences, second person ("you"), no markdown and no lists. Lead with the shape of the day (how many meetings, how busy), call out the most important or biggest meeting, and flag anything overdue. If the recent comments reveal a blocker, a waiting-on, or a needed reply, weave that in naturally.

Date: ${input.dateLabel}

Agenda:
${agenda}

Overdue tasks:
${fmt(input.overdue)}

Due today:
${fmt(input.dueToday)}

Upcoming tasks:
${fmt(input.upcoming)}

Personal to-do list:
${fmt(input.todos)}

Recent comments on overdue/today tasks:
${fmt(input.comments)}`;
  return runPrompt(prompt);
}

/** Propose personal to-do items based on the day's meetings and tasks. */
export async function suggestTodos(input: {
  dateLabel: string;
  agenda: string[];
  tasks: string[];
  existing: string[];
}): Promise<string[]> {
  const fmt = (arr: string[]) => (arr.length ? arr.map((t) => `- ${t}`).join("\n") : "- (none)");
  const prompt = `You are the user's assistant. Based on their day below, propose 3–6 concrete, actionable personal to-do items that would help them prepare for meetings or follow up on tasks. Do NOT duplicate items already on their to-do list, and don't just restate a meeting or task verbatim. Return ONE item per line, imperative voice (e.g. "Draft the Q3 slides"), no numbering, no bullets, no preamble.

Date: ${input.dateLabel}

Today's meetings:
${fmt(input.agenda)}

Open tasks:
${fmt(input.tasks)}

Already on the to-do list:
${fmt(input.existing)}`;
  const out = await runPrompt(prompt);
  return out
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 8);
}

/** Produce a short spoken briefing from a prebuilt activity context. */
export async function rundown(context: string): Promise<string> {
  const prompt = `You are the user's assistant giving a brief spoken status rundown of their Claude Code activity. Use the data below. Speak naturally in 3–5 short sentences, second person ("you"). Lead with the most important thing, mention notable activity, and end with any heads-up. No markdown, no lists.

Data:
${context}`;
  return runPrompt(prompt);
}
