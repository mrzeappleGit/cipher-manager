// DTOs from cipherManager's /api/g2/* facade (see src-tauri/src/g2.rs).

export interface NowDto {
  event: string | null;
  overdue: number;
  dueToday: number;
  runningJobs: number;
  usage5h: string;
  deckLive: boolean;
  ts: number;
}

export interface DeckDto {
  events: string[];
  tasks: string[];
  deckLive: boolean;
  ts: number;
}

export interface BriefDto {
  pages: string[];
  ts: number;
}

export interface ProjectsDto {
  projects: string[];
  ts: number;
}

export type Route =
  | { name: "root"; sel: number }
  | { name: "now" }
  | { name: "brief"; page: number }
  | { name: "deck"; page: number }
  | { name: "projects" }
  | { name: "status" }
  | { name: "pair"; code?: string; error?: string };

export type Gesture = "up" | "down" | "press" | "double";
