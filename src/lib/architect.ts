// OS architect: turn a stream-of-consciousness "here's what I do every day"
// into a proposed skill architecture (domains → tasks → skills → automations),
// then one headless run writes every accepted SKILL.md.

import { runPrompt } from "./ai";
import type { Skill } from "../types";

export interface ProposedSkill {
  slug: string;
  domain: string;
  name: string;
  description: string;
  steps: string[];
  /** haiku | sonnet | opus — suggested per task weight. */
  model: string | null;
  /** Set when the task should run unattended once a day. */
  automation: { time: string; why: string } | null;
}

export async function proposeArchitecture(
  brainDump: string,
  existing: Skill[]
): Promise<ProposedSkill[]> {
  const have = existing.map((s) => `- ${s.id}: ${s.description || s.name}`).join("\n");
  const out = await runPrompt(
    `You are designing the skill architecture of a personal Claude Code agentic OS. The user describes their day-to-day below. Break it into domains (research, content, work-admin, …) and discrete repeatable tasks; each task becomes a skill.

Existing skills — do NOT re-propose these:
${have || "- (none)"}

Reply with ONLY a JSON object, no code fences:
{"skills":[{"slug":"kebab-case-id","domain":"one-word","name":"Short name","description":"one line: what it does and when to use it","steps":["3-8 imperative steps"],"model":"haiku"|"sonnet"|"opus","automation":{"time":"HH:MM","why":"one line"}|null}]}

Rules:
- Only propose skills for things the user actually described doing repeatedly.
- model: haiku for simple scans/summaries, sonnet for typical work, opus only for deep multi-step research.
- automation: only for tasks that make sense unattended once a day (e.g. a morning scan); otherwise null.
- 3 to 10 skills total. Quality over quantity.

The user's description:
"""${brainDump}"""`,
    3000
  );
  const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  const skills: ProposedSkill[] = Array.isArray(parsed?.skills) ? parsed.skills : [];
  return skills.filter((s) => s.slug && s.name && Array.isArray(s.steps));
}

/** One headless-run prompt that writes every accepted SKILL.md. */
export function generationPrompt(selected: ProposedSkill[], vaultDir: string): string {
  const blocks = selected
    .map(
      (s, i) => `Skill ${i + 1}: ${s.slug}
- name: ${s.name}
- domain: ${s.domain}
- model: ${s.model || "sonnet"}
- description: ${s.description}
- outline:
${s.steps.map((st) => `  - ${st}`).join("\n")}`
    )
    .join("\n\n");
  const vaultNote = vaultDir.trim()
    ? `Skills that produce reports must write them to ${vaultDir}\\output\\<domain>\\<topic>-<YYYY-MM-DD>.md per the vault's CLAUDE.md memory contract, and also print the report as their final output.`
    : "Skills that produce reports should print them as their final output.";

  return `Create the following Claude Code skills. For each one, write ~/.claude/skills/<slug>/SKILL.md starting with YAML frontmatter:
---
name: <slug>
description: <the description>
domain: <the domain>
model: <the model>
---
followed by clear, step-by-step markdown instructions expanded from the outline (concrete enough that every run behaves the same way). ${vaultNote}

${blocks}

After writing all files, print the list of created file paths.`;
}
