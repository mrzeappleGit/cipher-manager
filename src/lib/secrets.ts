// Frontend view of the backend credential store (WP-0B). Secrets never live in
// the frontend: this module holds only a presence map (booleans) and hands out
// the placeholder `{{secret:<id>}}`, which the backend swaps for the real value
// inside the proxy path. Configure via the desktop app; the phone sees presence
// and sends placeholders that serve resolves.

import { useSyncExternalStore } from "react";
import { api } from "../api";
import type { ProviderId } from "./settings";

// Cached presence, loaded once at boot and refreshed after set/delete.
let presence: Record<string, boolean> = {};
let listeners: Array<() => void> = [];
const emit = () => listeners.forEach((l) => l());

export function onSecretsChange(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

export async function loadSecretPresence(): Promise<void> {
  try {
    presence = await api.secretPresence();
    emit();
  } catch {
    /* mock/snapshot mode — no vault, everything "not configured" */
  }
}

export function hasSecret(id: string): boolean {
  return presence[id] === true;
}

/** React hook: re-renders when secret presence changes. */
export function useSecretPresence(): Record<string, boolean> {
  return useSyncExternalStore(onSecretsChange, () => presence);
}

/** Backend placeholder for a stored secret. */
export function secretRef(id: string): string {
  return `{{secret:${id}}}`;
}

/** The vault id for a provider's chat/embeddings key. */
export function providerKeyId(provider: ProviderId): string {
  return `${provider}-api-key`;
}

/** Value to SEND in a request. Legacy raw value when present, else always the
 * placeholder — the backend resolves it from the vault (or to empty if absent),
 * so this is independent of frontend presence-load timing. Use for requests,
 * NOT for "is it configured?" gates. */
export function keyRef(id: string, legacy: string): string {
  const raw = legacy.trim();
  return raw || secretRef(id);
}

/** Whether a secret is configured — for gates/detection. Presence-based, so it
 * reflects the vault only after loadSecretPresence(); components that gate on it
 * should subscribe via useSecretPresence to re-render when presence arrives. */
export function keyConfigured(id: string, legacy: string): boolean {
  return legacy.trim().length > 0 || hasSecret(id);
}

/** What to put in a request for a provider key: the placeholder when the vault
 * has it, else the legacy raw value (pre-migration), else "". */
export function providerKeyRef(provider: ProviderId, legacy: string): string {
  return keyRef(providerKeyId(provider), legacy);
}

/** Configured = raw legacy value present OR stored in the vault. */
export function providerKeyConfigured(provider: ProviderId, legacy: string): boolean {
  return legacy.trim().length > 0 || hasSecret(providerKeyId(provider));
}

export async function setSecret(id: string, value: string): Promise<void> {
  await api.setSecret(id, value);
  await loadSecretPresence();
}

export async function deleteSecret(id: string): Promise<void> {
  await api.deleteSecret(id);
  await loadSecretPresence();
}
