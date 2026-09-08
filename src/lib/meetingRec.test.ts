// Pure meeting-note logic: parsing, task merging, ownership filtering.
import { describe, expect, it } from "vitest";
import {
  actionOwner,
  myActions,
  parseMeetingNote,
  parseSpeakerNames,
  renameSpeakers,
  transcriptSpeakers,
  withSummary,
  withTasks,
} from "./meetingRec";

const NOTE = [
  "---",
  "title: A/B testing sync",
  "date: 2026-07-09T17:40:53.840Z",
  "duration: 10m",
  "type: meeting",
  "---",
  "",
  "# A/B testing sync",
  "",
  "## Summary",
  "",
  "- Help survey test resumed today.",
  "",
  "## Key decisions", // AI summaries emit their own headings — must not end the section
  "",
  "- No copy changes during the test.",
  "",
  "Action items:",
  "- Me → add the pause timings to the ticket",
  "- **Jenn** → finish the workspace",
  "",
  "## Transcript",
  "",
  "**Me:** hello",
  "",
  "**Speaker 1:** hi there",
  "",
].join("\n");

describe("parseMeetingNote", () => {
  it("reads frontmatter and runs the summary to ## Transcript", () => {
    const p = parseMeetingNote(NOTE);
    expect(p.title).toBe("A/B testing sync");
    expect(p.duration).toBe("10m");
    expect(p.summary).toContain("Key decisions"); // inner heading survives
    expect(p.summary).not.toContain("**Me:** hello"); // transcript excluded
    expect(p.actions).toEqual([
      "Me → add the pause timings to the ticket",
      "**Jenn** → finish the workspace",
    ]);
  });
});

describe("actions", () => {
  it("extracts owners and filters to mine (unowned stays)", () => {
    expect(actionOwner("**Jenn** → finish the workspace")).toBe("Jenn");
    expect(actionOwner("just a note")).toBeNull();
    const mine = myActions([
      "Me → do the thing",
      "**Jenn** → her thing",
      "follow up on budget", // no owner → implicit-you, kept
    ]);
    expect(mine).toEqual(["Me → do the thing", "follow up on budget"]);
  });

  it("withTasks dedupes against existing summary bullets", () => {
    const next = withTasks(NOTE, [
      "Me → add the pause timings to the ticket", // already present
      "Me → send the recap email", // new
    ]);
    const matches = next.match(/send the recap email/g) ?? [];
    expect(matches.length).toBe(1);
    expect((next.match(/add the pause timings/g) ?? []).length).toBe(1);
  });
});

describe("summary + speakers", () => {
  it("withSummary replaces the section and keeps the transcript", () => {
    const next = withSummary(NOTE, "- replaced");
    expect(parseMeetingNote(next).summary).toBe("- replaced");
    expect(next).toContain("**Speaker 1:** hi there");
  });

  it("renames diarized speakers everywhere", () => {
    expect(transcriptSpeakers(NOTE)).toEqual(["Speaker 1"]);
    const renamed = renameSpeakers(NOTE, { "Speaker 1": "Jenn" });
    expect(renamed).toContain("**Jenn:** hi there");
    expect(renamed).not.toContain("**Speaker 1:**");
  });

  it("parseSpeakerNames keeps only plausible answers for known labels", () => {
    const speakers = ["Speaker 1", "Speaker 2"];
    const out = 'Sure! {"Speaker 1": "Jenn", "Speaker 2": "unknown", "Speaker 9": "Bob", "Me": "Matt"}';
    expect(parseSpeakerNames(out, speakers)).toEqual({ "Speaker 1": "Jenn" });
    expect(parseSpeakerNames("no json here", speakers)).toEqual({});
    expect(parseSpeakerNames("{broken json", speakers)).toEqual({});
    expect(parseSpeakerNames('{"Speaker 1": "Speaker 2"}', speakers)).toEqual({});
  });
});
