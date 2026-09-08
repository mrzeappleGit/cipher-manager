// Local Deck state: a personal to-do list and the set of tasks the user has
// muted from the AI day summary. Both persist in localStorage.

import { useSyncExternalStore } from "react";
import { mirrorAppState } from "./appState";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

const TODO_KEY = "cipher-manager.deck-todos";
const IGNORE_KEY = "cipher-manager.deck-ignore";

let todos: Todo[] = loadTodos();
let ignored: Set<string> = loadIgnore();
let listeners: Array<() => void> = [];
let seq = 0;

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

function loadTodos(): Todo[] {
  try {
    const v = JSON.parse(localStorage.getItem(TODO_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function persistTodos() {
  try {
    localStorage.setItem(TODO_KEY, JSON.stringify(todos));
  } catch {
    /* ignore */
  }
  todoDisk.onPersist();
  emit();
}

// Shared on-disk copies — see lib/appState.ts.
const todoDisk = mirrorAppState(
  "deck-todos",
  (raw) => {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) {
        todos = v;
        try {
          localStorage.setItem(TODO_KEY, raw);
        } catch {
          /* ignore */
        }
        emit();
      }
    } catch {
      /* bad file — keep local */
    }
  },
  () => JSON.stringify(todos)
);

function loadIgnore(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(IGNORE_KEY) || "[]");
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}
const ignoreDisk = mirrorAppState(
  "deck-ignore",
  (raw) => {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) {
        ignored = new Set(v);
        try {
          localStorage.setItem(IGNORE_KEY, raw);
        } catch {
          /* ignore */
        }
        emit();
      }
    } catch {
      /* bad file — keep local */
    }
  },
  () => JSON.stringify([...ignored])
);

function persistIgnore() {
  try {
    localStorage.setItem(IGNORE_KEY, JSON.stringify([...ignored]));
  } catch {
    /* ignore */
  }
  ignoreDisk.onPersist();
  emit();
}

// ---- To-dos ----

export function addTodo(text: string): void {
  const t = text.trim();
  if (!t) return;
  // Idempotent: the meeting auto-flow re-adds the same items after every
  // re-summarize, so an identical open to-do means "already tracked".
  if (todos.some((x) => !x.done && x.text.trim().toLowerCase() === t.toLowerCase())) return;
  todos = [{ id: `td${Date.now()}_${seq++}`, text: t, done: false, createdAt: Date.now() }, ...todos];
  persistTodos();
}
export function toggleTodo(id: string): void {
  todos = todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  persistTodos();
}
export function removeTodo(id: string): void {
  todos = todos.filter((t) => t.id !== id);
  persistTodos();
}
export function clearDoneTodos(): void {
  todos = todos.filter((t) => !t.done);
  persistTodos();
}

const getTodos = () => todos;
export function useTodos(): Todo[] {
  return useSyncExternalStore(subscribe, getTodos, getTodos);
}

// ---- Ignored-from-summary tasks ----

export function toggleIgnore(key: string): void {
  const next = new Set(ignored);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  ignored = next;
  persistIgnore();
}

const getIgnored = () => ignored;
export function useIgnored(): Set<string> {
  return useSyncExternalStore(subscribe, getIgnored, getIgnored);
}
