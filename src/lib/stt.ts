// Speech-to-text over the already-configured provider keys: ElevenLabs Scribe
// when an ElevenLabs key is set, else OpenAI Whisper. No new settings.

import { sttRequest } from "../api";
import { getSettings } from "./settings";
import { keyRef, keyConfigured } from "./secrets";

export function sttProvider(): "elevenlabs" | "openai" | null {
  const s = getSettings();
  if (keyConfigured("eleven-api-key", s.elevenApiKey)) return "elevenlabs";
  if (keyConfigured("openai-api-key", s.apiKeys.openai)) return "openai";
  return null;
}

export async function transcribe(blob: Blob): Promise<string> {
  const provider = sttProvider();
  if (!provider) {
    throw new Error("Add an ElevenLabs or OpenAI API key in Settings to use voice input.");
  }
  const s = getSettings();
  const filename = "audio.webm";
  const resp =
    provider === "elevenlabs"
      ? await sttRequest({
          url: "https://api.elevenlabs.io/v1/speech-to-text",
          headers: { "xi-api-key": keyRef("eleven-api-key", s.elevenApiKey) },
          blob,
          filename,
          // ponytail: language pinned to English to stop hallucinated foreign
          // transcripts on noise; make it a setting if multilingual input matters.
          fields: { model_id: "scribe_v1", language_code: "en" },
        })
      : await sttRequest({
          url: "https://api.openai.com/v1/audio/transcriptions",
          headers: { Authorization: `Bearer ${keyRef("openai-api-key", s.apiKeys.openai)}` },
          blob,
          filename,
          fields: { model: "whisper-1", language: "en" },
        });
  if (resp.status >= 300) {
    throw new Error(`Transcription failed (${resp.status}): ${resp.text.slice(0, 200)}`);
  }
  const text = JSON.parse(resp.text)?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("No speech recognized.");
  return text.trim();
}
