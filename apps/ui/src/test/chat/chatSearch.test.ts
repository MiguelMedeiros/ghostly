import { describe, expect, it } from "vitest";
import { foldText, matchRanges, searchable, searchMessages } from "../../lib/chatSearch";
import type { ChatMessage } from "../../lib/types";
import { locales } from "../../locales";
import { translateWith } from "../../locales/translate";

// covers: chat.search

const message = (id: string, text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id, text, sender: "peer", timestamp: 1, ...patch });
const file = (name: string) => ({ id: "f", name, size: 1, mime: "application/pdf" });

describe("foldText", () => {
  it("drops case and accents", () => {
    expect(foldText("Ação É Über Ñandú")).toBe("acao e uber nandu");
    expect(foldText("İstanbul")).toBe("istanbul");
  });
});

describe("searchMessages", () => {
  const items = searchable([
    message("m1", "Vamos ao café amanhã?"),
    message("m2", "📎 Relatório.pdf", { file: file("Relatório Final.pdf") }),
    message("m3", "CAFE is on me"),
    message("m4", "joined", { sender: "system" }),
    message("m5", "call ended", { callEvent: { type: "call_ended" } }),
    message("m6", "café", { paymentId: "p1" }),
  ]);

  it("finds text whatever its case and accents, newest first", () => {
    expect(searchMessages(items, "cafe")).toEqual(["m3", "m1"]);
    expect(searchMessages(items, "CAFÉ")).toEqual(["m3", "m1"]);
    expect(searchMessages(items, "AMANHA")).toEqual(["m1"]);
  });

  it("finds a file by its name, not by the line its message carries", () => {
    expect(searchMessages(items, "relatorio final")).toEqual(["m2"]);
    expect(searchMessages(items, "📎")).toEqual([]);
  });

  it("leaves out notices, call lines and payments", () => {
    expect(searchMessages(items, "joined")).toEqual([]);
    expect(searchMessages(items, "call")).toEqual([]);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(searchMessages(items, "")).toEqual([]);
    expect(searchMessages(items, "   ")).toEqual([]);
  });
});

describe("a voice message, a video or a picture by what it is", () => {
  // The recorder names a voice message in English whatever the profile's language (packages/core/src/voice.ts).
  const items = (language: "en" | "pt" | "es") => searchable([
    message("v1", "🎤 Voice message (0:12)", { file: { id: "v", name: "Voice message 2026-10-05 10-00-00.webm", size: 1, mime: "audio/webm", voice: { duration: 12_000, peaks: [] } } }),
    message("c1", "🎬 clip.mp4", { file: { id: "c", name: "clip.mp4", size: 1, mime: "video/mp4", video: { duration: 3_000, width: 640, height: 360 } } }),
    message("p1", "📎 IMG_0042.jpg", { file: { id: "p", name: "IMG_0042.jpg", size: 1, mime: "image/jpeg" } }),
    message("d1", "📎 Relatório.pdf", { file: file("Relatório.pdf") }),
    message("t1", "a text that says nothing of it"),
  ], translateWith(locales[language], language));

  it("in Portuguese: voz, vídeo, imagem, and the English words still", () => {
    const pt = items("pt");
    expect(searchMessages(pt, "voz")).toEqual(["v1"]);
    expect(searchMessages(pt, "mensagem de voz")).toEqual(["v1"]);
    expect(searchMessages(pt, "video")).toEqual(["c1"]);
    expect(searchMessages(pt, "imagem")).toEqual(["p1"]);
    expect(searchMessages(pt, "voice")).toEqual(["v1"]);
    expect(searchMessages(pt, "picture")).toEqual(["p1"]);
  });

  it("in Spanish: mensaje de voz, imagen", () => {
    const es = items("es");
    expect(searchMessages(es, "voz")).toEqual(["v1"]);
    expect(searchMessages(es, "MENSAJE")).toEqual(["v1"]);
    expect(searchMessages(es, "imagen")).toEqual(["p1"]);
    expect(searchMessages(es, "imagem")).toEqual([]);
  });

  it("in English, only the English words; a file of another kind gets none", () => {
    const en = items("en");
    expect(searchMessages(en, "voice message")).toEqual(["v1"]);
    expect(searchMessages(en, "voz")).toEqual([]);
    expect(searchMessages(en, "file")).toEqual([]);
  });

  it("the name and the kind do not run together", () => {
    expect(searchMessages(items("en"), "mp4 video")).toEqual([]);
  });
});

describe("matchRanges", () => {
  const cut = (text: string, query: string) => matchRanges(text, query).map(([from, to]) => text.slice(from, to));

  it("gives each match's place in the text as written", () => {
    expect(matchRanges("Café e cafe", "cafe")).toEqual([[0, 4], [7, 11]]);
    expect(cut("Ação ou acao", "ACAO")).toEqual(["Ação", "acao"]);
  });

  it("keeps a combining accent with its letter", () => {
    const decomposed = "café bom";
    expect(cut(decomposed, "cafe")).toEqual(["café"]);
  });

  it("finds nothing for an empty query", () => {
    expect(matchRanges("anything", " ")).toEqual([]);
  });
});
