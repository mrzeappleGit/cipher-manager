// Read-aloud. Two engines: the local Web Speech API (default) or ElevenLabs
// (proxied through the backend to avoid CORS), selectable in Settings.

import { useSyncExternalStore } from "react";
import { ttsRequest } from "../api";
import { getSettings } from "./settings";
import { keyRef, keyConfigured } from "./secrets";

let speakingId = "";
let currentAudio: HTMLAudioElement | null = null;
let listeners: Array<() => void> = [];

function emit() {
  for (const l of listeners) l();
}

function webSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && (webSupported() || typeof Audio !== "undefined");
}

function stopAll() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (webSupported()) window.speechSynthesis.cancel();
}

function webSpeak(id: string, text: string) {
  if (!webSupported()) {
    speakingId = "";
    emit();
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  u.onend = () => {
    if (speakingId === id) {
      speakingId = "";
      emit();
    }
  };
  u.onerror = () => {
    if (speakingId === id) {
      speakingId = "";
      emit();
    }
  };
  window.speechSynthesis.speak(u);
}

export async function speak(id: string, text: string): Promise<void> {
  if (!text.trim()) return;
  stopAll();
  speakingId = id;
  emit();

  const s = getSettings();
  if (s.ttsEngine === "elevenlabs" && keyConfigured("eleven-api-key", s.elevenApiKey)) {
    try {
      const voice = s.elevenVoiceId.trim() || "21m00Tcm4TlvDq8ikWAM";
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}`;
      const { status, bodyBase64 } = await ttsRequest(
        url,
        {
          "xi-api-key": keyRef("eleven-api-key", s.elevenApiKey),
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        JSON.stringify({ text, model_id: s.elevenModel || "eleven_turbo_v2_5" })
      );
      if (status < 200 || status >= 300 || !bodyBase64) {
        throw new Error(`ElevenLabs error ${status}`);
      }
      if (speakingId !== id) return; // stopped while fetching
      const audio = new Audio(`data:audio/mpeg;base64,${bodyBase64}`);
      currentAudio = audio;
      const done = () => {
        if (speakingId === id) {
          speakingId = "";
          emit();
        }
      };
      audio.onended = done;
      audio.onerror = done;
      await audio.play();
      return;
    } catch {
      // Fall back to local Web Speech.
      currentAudio = null;
      if (speakingId !== id) return;
    }
  }

  webSpeak(id, text);
}

export function stopSpeaking(): void {
  stopAll();
  speakingId = "";
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

const getSnapshot = () => speakingId;

export function useSpeakingId(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
