// Fictional demonstration data; no user transcripts or account configuration.
// Mock data used only when the app runs outside Tauri (e.g. a plain browser
// during development). The real data comes from the Rust backend.

import type {
  AppInfo,
  DayRecap,
  DiskStats,
  Documents,
  Highlight,
  ProjectSummary,
  DeckDashboard,
  RecentSession,
  RecentUsage,
  SearchResult,
  SessionDetail,
  SessionSummary,
  Skill,
  TokenTotals,
  UsageStats,
} from "../types";

const tok = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite5m: number
): TokenTotals => ({ input, output, cacheRead, cacheWrite5m, cacheWrite1h: 0 });

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-5";

interface Seed {
  id: string;
  name: string;
  path: string;
  sessions: number;
  messages: number;
  size: number;
  cost: number;
  tokens: TokenTotals;
  last: string;
  models: string[];
}

const SEEDS: Seed[] = [
  { id: "C--Projects-demo-notebook", name: "demo-notebook", path: "C:\\Projects\\demo-notebook", sessions: 1, messages: 100, size: 1000000, cost: 3, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
  { id: "C--Projects-sample-dashboard", name: "sample-dashboard", path: "C:\\Projects\\sample-dashboard", sessions: 2, messages: 200, size: 2000000, cost: 6, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
  { id: "C--Projects-text-editor", name: "text-editor", path: "C:\\Projects\\text-editor", sessions: 3, messages: 300, size: 3000000, cost: 9, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
  { id: "C--Projects-notes-plugin", name: "notes-plugin", path: "C:\\Projects\\notes-plugin", sessions: 4, messages: 400, size: 4000000, cost: 12, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
  { id: "C--Projects-event-planner", name: "event-planner", path: "C:\\Projects\\event-planner", sessions: 5, messages: 500, size: 5000000, cost: 15, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
  { id: "C--Projects-media-player", name: "media-player", path: "C:\\Projects\\media-player", sessions: 6, messages: 600, size: 6000000, cost: 18, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
  { id: "C--Projects-task-board", name: "task-board", path: "C:\\Projects\\task-board", sessions: 7, messages: 700, size: 7000000, cost: 21, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
  { id: "C--Projects-audio-library", name: "audio-library", path: "C:\\Projects\\audio-library", sessions: 8, messages: 800, size: 8000000, cost: 24, tokens: tok(100000, 20000, 300000, 10000), last: "2026-07-01T12:00:00Z", models: [SONNET] },
];

export function projects(): ProjectSummary[] {
  return SEEDS.map((s) => ({
    id: s.id,
    path: s.path,
    pathExists: true,
    name: s.name,
    sessionCount: s.sessions,
    messageCount: s.messages,
    sizeBytes: s.size,
    firstActivity: "2026-05-20T10:00:00Z",
    lastActivity: s.last,
    tokens: s.tokens,
    costUsd: s.cost,
    models: s.models,
  }));
}

function addTok(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

export function usage(): UsageStats {
  const ps = projects();
  let tokens = tok(0, 0, 0, 0);
  let totalCost = 0;
  let sessionCount = 0;
  let messageCount = 0;
  let totalSize = 0;
  for (const p of ps) {
    tokens = addTok(tokens, p.tokens);
    totalCost += p.costUsd;
    sessionCount += p.sessionCount;
    messageCount += p.messageCount;
    totalSize += p.sizeBytes;
  }

  const byDay = [];
  const today = new Date();
  for (let i = 44; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    const wave = 0.5 + 0.5 * Math.sin(i / 4);
    const spike = i % 9 === 0 ? 2.2 : 1;
    const cost = +(6 * wave * spike).toFixed(2);
    byDay.push({
      day,
      cost_usd: cost,
      costUsd: cost,
      tokens: tok(
        Math.round(60_000 * wave * spike),
        Math.round(22_000 * wave * spike),
        Math.round(1_200_000 * wave * spike),
        Math.round(90_000 * wave * spike)
      ),
      messageCount: Math.round(40 * wave * spike),
    } as UsageStats["byDay"][number]);
  }

  return {
    tokens,
    totalCost,
    sessionCount,
    messageCount,
    projectCount: ps.length,
    totalSizeBytes: totalSize,
    firstActivity: "2026-05-20T10:00:00Z",
    lastActivity: "2026-07-03T18:22:00Z",
    byModel: [
      { model: OPUS, tokens: tok(6_300_000, 1_900_000, 118_000_000, 9_200_000), costUsd: 236.4, messageCount: 5100 },
      { model: SONNET, tokens: tok(1_600_000, 520_000, 28_000_000, 2_100_000), costUsd: 33.9, messageCount: 1800 },
    ],
    byProject: ps.map((p) => ({ id: p.id, name: p.name, tokens: p.tokens, costUsd: p.costUsd })),
    byDay,
  };
}

const TITLES: Record<string, string[]> = {
  default: [
    "Build the landing page and auth flow",
    "Fix timezone conversion bug",
    "Refactor the storage layer",
    "Add Discord webhook notifications",
    "Set up VPS deploy pipeline",
  ],
};

export function sessions(projectId: string): SessionSummary[] {
  const p = projects().find((x) => x.id === projectId);
  const count = p?.sessionCount ?? 3;
  const titles = TITLES.default;
  const out: SessionSummary[] = [];
  for (let i = 0; i < count; i++) {
    const t = tok(120_000 + i * 9000, 40_000, 3_400_000, 260_000);
    out.push({
      id: `${projectId.slice(-4)}-session-${i + 1}`,
      projectId,
      title: titles[i % titles.length],
      firstPrompt: "Can you help me create a custom version of this app hosted on my VPS…",
      messageCount: 120 + i * 30,
      userMessages: 40 + i * 8,
      assistantMessages: 80 + i * 22,
      sizeBytes: 2_000_000 + i * 900_000,
      startTime: `2026-06-${String(10 + i).padStart(2, "0")}T02:03:00Z`,
      endTime: `2026-06-${String(10 + i).padStart(2, "0")}T04:20:00Z`,
      tokens: t,
      costUsd: 6 + i * 2.4,
      models: [OPUS],
      gitBranch: "main",
      hasSubagents: i % 2 === 0,
    });
  }
  return out;
}

export function sessionDetail(projectId: string, sessionId: string): SessionDetail {
  const summary = sessions(projectId).find((s) => s.id === sessionId) ?? sessions(projectId)[0];
  return {
    summary,
    messages: [
      {
        uuid: "1",
        role: "user",
        kind: "user",
        timestamp: "2026-06-24T02:03:18Z",
        model: null,
        text: "Please add a calendar view to this fictional demo project.\n\nPlease make a plan based on my notes first.",
        thinking: null,
        toolCalls: [],
        tokens: null,
        costUsd: 0,
        isSidechain: false,
      },
      {
        uuid: "2",
        role: "assistant",
        kind: "assistant",
        timestamp: "2026-06-24T02:03:59Z",
        model: OPUS,
        text: "I will add the calendar view using the existing event data and check keyboard navigation.",
        thinking: "This is a fictional example of planning a calendar view.",
        toolCalls: [{ name: "Bash", inputPreview: '{"command":"ls -la"}' }],
        tokens: tok(7599, 3046, 24922, 2580),
        costUsd: 0.34,
        isSidechain: false,
      },
    ],
  };
}

export function disk(): DiskStats {
  const ps = projects();
  return {
    totalBytes: ps.reduce((a, p) => a + p.sizeBytes, 0),
    projects: ps.map((p) => ({
      id: p.id,
      name: p.name,
      sizeBytes: p.sizeBytes,
      sessionCount: p.sessionCount,
      lastActivity: p.lastActivity,
      sessions: sessions(p.id).map((s) => ({
        id: s.id,
        title: s.title,
        sizeBytes: s.sizeBytes,
        lastActivity: s.endTime,
      })),
    })),
  };
}

export function search(query: string): SearchResult[] {
  if (!query.trim()) return [];
  const ps = projects();
  return ps.slice(0, 5).map((p, i) => ({
    projectId: p.id,
    projectName: p.name,
    sessionId: `${p.id.slice(-4)}-session-1`,
    sessionTitle: TITLES.default[i % TITLES.default.length],
    role: i % 2 === 0 ? "user" : "assistant",
    timestamp: p.lastActivity,
    snippet: `…matched "${query}" here: let me help you with ${query} in the ${p.name} project and wire it up…`,
  }));
}

export function recaps(): DayRecap[] {
  const ps = projects();
  const days: DayRecap[] = [];
  const base = new Date();
  for (let d = 0; d < 7; d++) {
    const date = new Date(base);
    date.setDate(date.getDate() - d);
    const day = date.toISOString().slice(0, 10);

    const dayProjects = ps.filter((_, i) => (i + d) % 3 === 0).slice(0, 3);
    const projectsRecap = dayProjects.map((p) => {
      const sess = sessions(p.id)
        .slice(0, 2)
        .map((s) => ({
          id: s.id,
          title: s.title,
          firstPrompt: s.firstPrompt,
          messageCount: s.messageCount,
          tokens: s.tokens,
        }));
      const tokens = sess.reduce((a, s) => addTok(a, s.tokens), tok(0, 0, 0, 0));
      return {
        id: p.id,
        name: p.name,
        sessionCount: sess.length,
        messageCount: sess.reduce((a, s) => a + s.messageCount, 0),
        tokens,
        sessions: sess,
      };
    });

    const tokens = projectsRecap.reduce((a, pr) => addTok(a, pr.tokens), tok(0, 0, 0, 0));
    days.push({
      day,
      sessionCount: projectsRecap.reduce((a, pr) => a + pr.sessionCount, 0),
      messageCount: projectsRecap.reduce((a, pr) => a + pr.messageCount, 0),
      tokens,
      costUsd: 0,
      projects: projectsRecap,
    });
  }
  return days;
}

export function recentUsage(): RecentUsage {
  return {
    h5: { tokens: tok(62_000, 22_000, 1_240_000, 92_000), messageCount: 34 },
    h24: { tokens: tok(280_000, 96_000, 5_420_000, 410_000), messageCount: 152 },
  };
}

export function emptyRecent(): RecentUsage {
  const z = tok(0, 0, 0, 0);
  return { h5: { tokens: z, messageCount: 0 }, h24: { tokens: z, messageCount: 0 } };
}

export function documents(): Documents {
  const P = "C:\\Users\\Demo\\.claude";
  return {
    plans: [
      { name: "event-planner-plan.md", path: `${P}\\plans\\event-planner-plan.md`, sizeBytes: 4200, modified: "2026-07-04T18:00:00Z", kind: "plan" },
      { name: "dashboard-plan.md", path: `${P}\\plans\\dashboard-plan.md`, sizeBytes: 8800, modified: "2026-07-03T12:00:00Z", kind: "plan" },
    ],
    memory: [
      {
        title: "sample-dashboard",
        docs: [
          { name: "MEMORY.md", path: `${P}\\projects\\sample-dashboard\\memory\\MEMORY.md`, sizeBytes: 900, modified: "2026-07-05T09:00:00Z", kind: "memory" },
          { name: "ui-preferences.md", path: `${P}\\projects\\sample-dashboard\\memory\\ui-preferences.md`, sizeBytes: 640, modified: "2026-07-05T09:00:00Z", kind: "memory" },
        ],
      },
      {
        title: "event-planner",
        docs: [
          { name: "MEMORY.md", path: `${P}\\projects\\event-planner\\memory\\MEMORY.md`, sizeBytes: 1200, modified: "2026-06-24T02:00:00Z", kind: "memory" },
          { name: "deployment-notes.md", path: `${P}\\projects\\event-planner\\memory\\deployment-notes.md`, sizeBytes: 2100, modified: "2026-06-24T02:00:00Z", kind: "memory" },
        ],
      },
    ],
  };
}

export function deckDashboard(): DeckDashboard {
  const at = (h: number, m: number, dayOff: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + dayOff);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const ev = (
    title: string,
    s: [number, number, number],
    e: [number, number, number],
    location: string,
    kind: DeckDashboard["events"][number]["kind"],
    who: string
  ) => ({
    title,
    start: at(...s),
    end: at(...e),
    location,
    kind,
    who,
    url: kind === "Video" ? "https://example.com/join" : null,
  });
  const task = (
    name: string,
    due: [number, number, number],
    proj: string,
    assignee: string,
    section: string,
    priority: string,
    tags: string[] = []
  ) => ({
    id: "",
    name,
    due: at(...due),
    proj,
    url: null,
    assignee,
    section,
    tags,
    numSubtasks: 0,
    fields: priority ? [{ name: "Priority", value: priority }] : [],
  });
  return {
    events: [
      ev("Team standup", [9, 0, 0], [9, 15, 0], "Zoom", "Video", "6 people"),
      ev("Product review", [10, 0, 0], [11, 0, 0], "Conf Room A", "Room", "You + 4"),
      ev("1:1 with Sam", [11, 30, 0], [12, 0, 0], "Google Meet", "Video", "Sam Rivera"),
      ev("Lunch", [12, 30, 0], [13, 30, 0], "—", "Block", "Blocked"),
      ev("Design sync", [14, 0, 0], [15, 0, 0], "Google Meet", "Video", "You + 3"),
      ev("Weekly planning", [16, 30, 0], [17, 30, 0], "Conf Room C", "Room", "Team"),
      ev("Roadmap workshop", [9, 30, 1], [11, 0, 1], "Conf Room A", "Room", "Team"),
      ev("Vendor call", [13, 0, 1], [13, 45, 1], "Zoom", "Video", "Acme Inc"),
      ev("All-hands", [10, 0, 2], [11, 0, 2], "Main Stage", "Room", "Company"),
      ev("Sprint review", [11, 0, 3], [12, 0, 3], "Zoom", "Video", "Team"),
      ev("Board prep", [14, 0, 4], [15, 30, 4], "Conf Room B", "Room", "Exec"),
    ],
    tasks: [
      task("Send signed vendor contract", [17, 0, -1], "Ops", "You", "In progress", "High"),
      task("Approve marketing budget", [12, 0, -2], "Finance", "You", "Blocked", "High"),
      task("Finalize Q3 roadmap", [15, 0, 0], "Product", "You", "In progress", "Medium"),
      task("Review design specs", [18, 0, 0], "Design", "You", "To do", "Medium"),
      task("Reply to customer feedback", [11, 0, 1], "Support", "You", "To do", "Low", ["waiting"]),
      task("Prep board deck", [9, 0, 2], "Exec", "You", "To do", "High", ["external"]),
      task("Write release notes", [14, 0, 3], "Product", "You", "To do", "Low"),
    ],
    source: "Sample data — add your calendar feed or Asana token in Settings",
    live: false,
    notes: [],
  };
}

export function taskDetail(): import("../types").TaskDetail {
  return {
    notes: "Sample description shown in preview mode. Connect Asana in Settings to see the real task's details, comments, and subtasks.",
    comments: [
      { author: "Sam Rivera", text: "Left a few notes on the doc — take a look when you can.", createdAt: null },
      { author: "You", text: "Thanks, will review before the sync.", createdAt: null },
    ],
    subtasks: [
      { name: "Draft outline", completed: true, due: null },
      { name: "Get sign-off", completed: false, due: null },
    ],
    attachments: [],
  };
}

export function skills(): Skill[] {
  const P = "C:\\Users\\Demo\\.claude\\skills";
  const s = (
    id: string,
    name: string,
    description: string,
    domain: string | null,
    modified: string
  ): Skill => ({
    id,
    name,
    description,
    domain,
    model: null,
    path: `${P}\\${id}\\SKILL.md`,
    sizeBytes: 4200,
    modified,
  });
  return [
    s("morning-trend-scan", "Morning trend scan", "Scan AI news, GitHub, and competitors; write a brief to the vault.", "research", "2026-07-05T07:00:00Z"),
    s("deep-research", "Deep research", "Multi-source research across web, GitHub, YouTube, and past vault entries.", "research", "2026-07-04T15:00:00Z"),
    s("youtube-search", "YouTube search", "Search YouTube on a topic and return a consolidated report.", "research", "2026-07-02T11:00:00Z"),
    s("content-draft", "Content draft", "Turn a wiki article into a first-draft script or post.", "content", "2026-07-03T09:00:00Z"),
    s("pinokio", "Pinokio", "Discover, launch, and use apps and tools for the current task.", null, "2026-03-23T19:19:00Z"),
  ];
}

export function recentSessions(limit: number): RecentSession[] {
  const out: RecentSession[] = [];
  for (const p of projects()) {
    for (const s of sessions(p.id)) {
      out.push({
        projectId: p.id,
        projectName: p.name,
        sessionId: s.id,
        title: s.title,
        firstPrompt: s.firstPrompt,
        startTime: s.startTime,
        endTime: s.endTime,
        messageCount: s.messageCount,
        models: s.models,
      });
    }
  }
  out.sort((a, b) => (b.endTime ?? "").localeCompare(a.endTime ?? ""));
  return out.slice(0, limit);
}

export function docContent(path: string): string {
  const name = path.split(/[\\/]/).pop() || "document.md";
  return `# ${name}\n\n_(Sample content shown in preview mode.)_\n\nThis document lives in your ~/.claude directory — run the desktop or web app to read the real file.\n\n- First point\n- Second point\n`;
}

export function appInfo(): AppInfo {
  return {
    claudeRoot: "C:\\Users\\Demo\\.claude",
    projectsDir: "C:\\Users\\Demo\\.claude\\projects",
    rootExists: true,
    archiveDir: "C:\\Users\\Demo\\.claude\\cipher-archive",
    auditPath: "C:\\Users\\Demo\\.claude\\cipher-jobs\\audit.jsonl",
    pricing: [
      { family: "Opus", input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
      { family: "Sonnet", input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { family: "Haiku", input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
    ],
  };
}

export function highlights(): Highlight[] {
  return [
    { start: 128, end: 141, score: 14.2 },
    { start: 342, end: 350, score: 11.8 },
    { start: 705, end: 713, score: 9.4 },
  ];
}
