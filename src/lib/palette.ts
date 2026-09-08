// Tiny global store for the ⌘K command palette's open state.

import { useSyncExternalStore } from "react";

let open = false;
let listeners: Array<() => void> = [];

function emit() {
  for (const l of listeners) l();
}

export function openPalette() {
  if (!open) {
    open = true;
    emit();
  }
}

export function closePalette() {
  if (open) {
    open = false;
    emit();
  }
}

export function togglePalette() {
  open = !open;
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

const getSnapshot = () => open;

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
