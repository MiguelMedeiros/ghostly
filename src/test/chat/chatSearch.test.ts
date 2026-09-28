import { describe, expect, it } from "vitest";
import { foldText, matchRanges, searchable, searchMessages } from "../../lib/chatSearch";
import type { ChatMessage } from "../../lib/types";

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
