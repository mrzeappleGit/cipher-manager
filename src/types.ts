// Mirrors the serde (camelCase) structs from the Rust backend.

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface ProjectSummary {
  id: string;
  path: string;
  pathExists: boolean;
  name: string;
  sessionCount: number;
  messageCount: number;
  sizeBytes: number;
  firstActivity: string | null;
  lastActivity: string | null;
  tokens: TokenTotals;
  costUsd: number;
  models: string[];
  /** Web URL of the git origin remote, when the project folder is a repo. */
  gitUrl?: string | null;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string | null;
  firstPrompt: string | null;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  sizeBytes: number;
  startTime: string | null;
  endTime: string | null;
  tokens: TokenTotals;
  costUsd: number;
  models: string[];
  gitBranch: string | null;
  hasSubagents: boolean;
  /** Which CLI produced it: "claude" (default) or "codex". */
  tool?: string;
}

export interface ToolCall {
  name: string;
  inputPreview: string;
}

export interface Message {
  uuid: string | null;
  role: string;
  kind: string;
  timestamp: string | null;
  model: string | null;
  text: string;
  thinking: string | null;
  toolCalls: ToolCall[];
  tokens: TokenTotals | null;
  costUsd: number;
  isSidechain: boolean;
}

export interface SessionDetail {
  summary: SessionSummary;
  messages: Message[];
}

export interface ModelUsage {
  model: string;
  tokens: TokenTotals;
  costUsd: number;
  messageCount: number;
}

export interface ProjectUsage {
  id: string;
  name: string;
  tokens: TokenTotals;
  costUsd: number;
}

export interface DayUsage {
  day: string;
  tokens: TokenTotals;
  costUsd: number;
  messageCount: number;
}

export interface UsageStats {
  tokens: TokenTotals;
  totalCost: number;
  sessionCount: number;
  messageCount: number;
  projectCount: number;
  totalSizeBytes: number;
  byModel: ModelUsage[];
  byProject: ProjectUsage[];
  byDay: DayUsage[];
  firstActivity: string | null;
  lastActivity: string | null;
}

export interface SearchResult {
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionTitle: string | null;
  role: string;
  timestamp: string | null;
  snippet: string;
  /** Semantic hits only: which index chunk matched. Keyword hits leave these unset. */
  chunkKind?: "intent" | "outcome" | null;
  messageUuid?: string | null;
  score?: number | null;
}

export interface DiskSession {
  id: string;
  title: string | null;
  sizeBytes: number;
  lastActivity: string | null;
}

export interface DiskProject {
  id: string;
  name: string;
  sizeBytes: number;
  sessionCount: number;
  lastActivity: string | null;
  sessions: DiskSession[];
}

export interface DiskStats {
  totalBytes: number;
  projects: DiskProject[];
}

export interface DayRecapSession {
  id: string;
  title: string | null;
  firstPrompt: string | null;
  messageCount: number;
  tokens: TokenTotals;
}

export interface DayRecapProject {
  id: string;
  name: string;
  sessionCount: number;
  messageCount: number;
  tokens: TokenTotals;
  sessions: DayRecapSession[];
}

export interface DayRecap {
  day: string;
  sessionCount: number;
  messageCount: number;
  tokens: TokenTotals;
  costUsd: number;
  projects: DayRecapProject[];
}

export interface RecentWindow {
  tokens: TokenTotals;
  messageCount: number;
}

export interface RecentUsage {
  h5: RecentWindow;
  h24: RecentWindow;
}

export interface DocFile {
  name: string;
  path: string;
  sizeBytes: number;
  modified: string | null;
  kind: string;
}

/** A vault document baked into the cloud snapshot (list entry + content). */
export interface SnapshotDoc {
  path: string;
  name: string;
  modified: number;
  content: string;
}

export interface DocGroup {
  title: string;
  docs: DocFile[];
}

export interface Documents {
  plans: DocFile[];
  memory: DocGroup[];
}

export interface RecentSession {
  projectId: string;
  projectName: string;
  sessionId: string;
  title: string | null;
  firstPrompt: string | null;
  startTime: string | null;
  endTime: string | null;
  messageCount: number;
  models: string[];
}

export type DeckEventKind = "Video" | "Room" | "Block" | "Other";

export interface DeckEvent {
  title: string;
  start: string;
  end: string;
  location: string;
  kind: DeckEventKind;
  who: string;
  url: string | null;
  /** Invite body/agenda text; absent in older snapshots and mock data. */
  description?: string;
}

export interface DeckTaskField {
  name: string;
  value: string;
}

export interface DeckTask {
  id: string;
  name: string;
  due: string;
  proj: string;
  url: string | null;
  assignee: string | null;
  section: string | null;
  tags: string[];
  numSubtasks: number;
  fields: DeckTaskField[];
}

export interface DeckComment {
  author: string;
  text: string;
  createdAt: string | null;
}

export interface DeckSubtask {
  name: string;
  completed: boolean;
  due: string | null;
}

export interface DeckAttachment {
  name: string;
  url: string | null;
}

export interface TaskDetail {
  notes: string;
  comments: DeckComment[];
  subtasks: DeckSubtask[];
  attachments: DeckAttachment[];
}

export interface TaskComments {
  id: string;
  comments: DeckComment[];
}

export interface DeckDashboard {
  events: DeckEvent[];
  tasks: DeckTask[];
  source: string;
  live: boolean;
  notes: string[];
}

/** A Home Assistant entity as shown on the Deck's Home card. */
export interface HaEntity {
  id: string;
  name: string;
  state: string;
  unit: string;
  domain: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  domain: string | null;
  /** Default model for runs (from a `model:` frontmatter field). */
  model: string | null;
  path: string;
  sizeBytes: number;
  modified: string | null;
}

export type JobStatus = "running" | "done" | "failed" | "canceled";

export interface Job {
  id: string;
  skill: string;
  label: string;
  status: JobStatus;
  output: string;
  exitCode: number | null;
  cwd: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AuditEntry {
  /** Absent on legacy records; false means the CLI was never launched. */
  launched?: boolean | null;
  id: string;
  skill: string;
  label: string;
  status: JobStatus;
  exitCode: number | null;
  cwd: string | null;
  prompt: string;
  bin: string;
  args: string;
  startedAt: string;
  finishedAt: string | null;
  outputExcerpt: string;
}

export interface PriceRow {
  family: string;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface AppInfo {
  claudeRoot: string | null;
  projectsDir: string | null;
  rootExists: boolean;
  pricing: PriceRow[];
  archiveDir: string | null;
  auditPath: string | null;
}

export function tokenTotal(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

/** Second-brain recall: one vault document hit (keyword or semantic). */
export interface VaultHit {
  /** Vault-relative path (feed to readVaultFile / obsidian links). */
  rel: string;
  name: string;
  snippet: string;
  score: number;
}

/** Meeting recorder: live status of the mic + system-audio capture. */
export interface RecordingStatus {
  recording: boolean;
  seconds: number;
  sources: string;
  /** Seconds since the last audible sample — 0 while someone is talking. */
  silenceSecs: number;
}

/** Meeting recorder: the finished, mixed WAV (+ per-source 16 kHz tracks). */
export interface RecordingDone {
  path: string;
  /** Mic-only track — always the local speaker, so "Me" labels are exact. */
  micPath: string | null;
  /** System-audio track — everyone else (diarized). */
  sysPath: string | null;
  seconds: number;
  sources: string;
}

/** A finished recording wav on disk (mixed final; track paths when present). */
export interface RecordingFile {
  path: string;
  name: string;
  seconds: number;
  modified: string | null;
  micPath: string | null;
  sysPath: string | null;
  /** Matching screen-<epoch>.mp4, so rescue can re-run visual analysis. */
  screenPath: string | null;
}

/** A window on-screen that can be chosen as a screen-recording source. */
export interface CaptureWindow {
  app: string;
  title: string;
  /** base64 JPEG preview (~240px wide); absent when the window couldn't be rendered */
  thumb?: string | null;
}

/** A saved screenshot. `thumb` is only filled in by the gallery listing. */
export interface Shot {
  name: string;
  path: string;
  width: number;
  height: number;
  /** Millis since the Unix epoch. */
  takenAt: number;
  bytes: number;
  thumb?: string | null;
}

/** An installed application, found via its Start Menu shortcut. */
export interface AppEntry {
  name: string;
  path: string;
}

/** A local file from the Windows Search index. */
export interface FileHit {
  name: string;
  path: string;
}

/** One Ollama-described visual moment from a recorded meeting video. */
export interface VisualNote {
  t: number;
  text: string;
}

/** Result of analyzing a meeting recording: slide/content notes plus periodic
 * Teams active-speaker guesses (timestamp, tile label). */
export interface MeetingVideoAnalysis {
  visuals: VisualNote[];
  speakers: [number, string][];
}

/** A user-added bookmark: a webpage or a local file-explorer folder. */
export interface CustomBookmark {
  id: string;
  name: string;
  kind: "web" | "folder";
  /** URL for web, absolute path for folder. */
  target: string;
  /** Optional user-defined group; empty/missing = ungrouped. */
  group?: string;
  addedMs: number;
}

/** A Brave bookmark: url set = webpage, children set = folder. */
export interface BookmarkNode {
  name: string;
  url?: string;
  children?: BookmarkNode[];
}

/** One Brave profile's bookmark tree. */
export interface BookmarkProfile {
  profile: string;
  roots: BookmarkNode[];
}

/** Even G2 glasses: a pairing code awaiting desktop approval. */
export interface G2Pending {
  code: string;
  device: string;
  createdMs: number;
}

/** Even G2 glasses: a paired client (id = token-hash prefix, never a token). */
export interface G2Client {
  id: string;
  device: string;
  createdMs: number;
  lastUsedMs: number;
}

/** cipherSizzle: a detected highlight window (seconds) and its loudness score. */
export interface Highlight {
  start: number;
  end: number;
  score: number;
}

/** cipherSizzle: a rendered clip file. */
export interface Clip {
  name: string;
  path: string;
  vertical: boolean;
  /** AI score 0–100 when aiScored, else dB over baseline (old jobs); 0 for stitched files. */
  score: number;
  /** Loudness signal (dB over baseline); 0 when the window had no audio spike. */
  audioScore: number;
  /** Short model explanation for AI-scored clips; empty otherwise. */
  reason: string;
  /** True when the local vision model produced score/reason. */
  aiScored: boolean;
  /** Clip bounds in the source video (seconds) — used by Adjust start & end. */
  start: number;
  end: number;
}

/** CipherCodex → vault sync: what one run produced. */
export interface CodexSyncResult {
  books: number;
  notebooks: number;
  written: string[];
  unchanged: number;
  skipped: number;
}

export interface DoctorFinding {
  kind: string;
  detail: string;
}

export interface DoctorReport {
  contractRel: string | null;
  findings: DoctorFinding[];
  patch: string | null;
  healthy: boolean;
}

export interface InboxSource {
  kind: string;
  label: string;
  projectId?: string | null;
  sessionId?: string | null;
  messageUuid?: string | null;
  rel?: string | null;
}

export interface InboxProposal {
  id: string;
  op: "create" | "update";
  targetRel: string;
  title: string;
  noteType: string;
  project: string;
  body: string;
  reason: string;
  sources: InboxSource[];
  sourceHash: string;
  status: "pending" | "approved" | "rejected";
  createdMs: number;
  decidedMs?: number | null;
}

/** One live (or exited) agent PTY session hosted by serve. */
export interface AgentSessionInfo {
  id: string;
  title: string;
  cwd: string;
  resumeSessionId?: string;
  projectId?: string;
  startedMs: number;
  status: "running" | "exited";
  exitCode?: number;
}

/** Normalized (0–1) crop boxes for the facecam-on-top vertical layout. */
export interface FacecamBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface FacecamLayout {
  cam: FacecamBox;
  game: FacecamBox;
}

/** A cloud vision backend (OpenAI- or Anthropic-shaped) for sizzle/meeting AI scans. */
export interface CloudVision {
  kind: "openai" | "anthropic";
  url: string;
  model: string;
  headers: Record<string, string>;
}

/** CipherScribe: one LanguageTool suggestion against the checked text.
 * Offsets are UTF-16 code units — the same unit JS string indexing uses, so
 * `text.substring(offset, offset + length)` recovers the flagged span as-is. */
export interface Issue {
  offset: number;
  length: number;
  message: string;
  replacements: string[];
  kind: "spelling" | "grammar" | "style";
}
