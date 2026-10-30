import { describe, expect, it } from "vitest";
import { loadDetector } from "../../lib/translateDetector";
import { translateFrom } from "../../lib/translateWhich";
import type { ChatMessage } from "../../lib/types";

// covers: app.i18n

/*
 * The real language detector (`@qvac/langdetect-text`): loaded on demand, it names the language of a chat line, so a
 * received message in another language is translated and one in the app's language is not.
 */

const received = (text: string): ChatMessage => ({ id: "m", text, sender: "peer", timestamp: 1 });

describe("the language detector", () => {
  it("loads, and names the language of a chat line", async () => {
    const detect = await loadDetector();
    expect(detect).toBeTypeOf("function");
    const [best] = detect!("Olá, tudo bem? Amanhã eu chego mais cedo para a reunião.");
    expect(best.code).toBe("pt");
    expect(best.probability).toBeGreaterThan(0.5);
  });

  it("makes a Portuguese message translated into an English app, and an English one not", async () => {
    const detect = (await loadDetector())!;
    const options = { appLanguage: "en" as const, detect, canTranslate: () => true };
    expect(translateFrom(received("Olá, tudo bem? Amanhã eu chego mais cedo para a reunião."), options)).toMatchObject({ from: "pt" });
    expect(translateFrom(received("Hi, how are you? Tomorrow I will be there earlier for the meeting."), options).from).toBeNull();
  });
});
