import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { MAX_TEXTS, TranslateError, translateTexts } from "../../desktop/translate";
import { rawError } from "../../lib/errorText";

/** The Desktop's translation, as the page asks Rust for it (apps/desktop/src/translate.rs). */
describe("translateTexts on Desktop", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (_command: string, { pair, texts }: { pair: string; texts: string[] }) => texts.map((text) => `[${pair}] ${text}`));
    vi.stubEnv("VITE_TRANSLATE", "1");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("asks Rust for the texts, in order", async () => {
    expect(await translateTexts("pt-en", ["Olá", "tudo bem?"])).toEqual(["[pt-en] Olá", "[pt-en] tudo bem?"]);
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("translate_texts", { pair: "pt-en", texts: ["Olá", "tudo bem?"] });
  });

  it("asks nothing for no texts", async () => {
    expect(await translateTexts("pt-en", [])).toEqual([]);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("sends more texts than the runtime takes at once in batches, one after the other, and answers them in order", async () => {
    const texts = Array.from({ length: MAX_TEXTS * 2 + 1 }, (_, i) => `${i}`);
    let running = 0;
    tauri.invoke.mockImplementation(async (_command: string, { texts }: { texts: string[] }) => {
      expect(++running).toBe(1);
      await Promise.resolve();
      running--;
      return texts.map((text) => `t${text}`);
    });
    expect(await translateTexts("pt-en", texts)).toEqual(texts.map((text) => `t${text}`));
    expect(tauri.invoke.mock.calls.map(([, args]) => (args as { texts: string[] }).texts.length)).toEqual([MAX_TEXTS, MAX_TEXTS, 1]);
  });

  it("says why there is no translation: the runtime or the model not downloaded, or it failed", async () => {
    for (const [said, reason] of [
      ["Translation is not installed", "not-installed"],
      ["Translation model not downloaded", "no-model"],
      ["Translation failed", "failed"],
      ["Unknown language pair", "failed"],
      ["Too much text at once", "failed"],
      ["Not available on this platform", "failed"],
    ] as const) {
      tauri.invoke.mockRejectedValueOnce(said);
      const error = await translateTexts("pt-en", ["Olá"]).catch((error: unknown) => error);
      expect(error, said).toBeInstanceOf(TranslateError);
      expect((error as TranslateError).reason, said).toBe(reason);
      // Rust's words, for the details behind the ⓘ: never a message's text.
      expect(rawError(error), said).toBe(said);
    }
  });

  it("starts nothing in a build without translation (VITE_TRANSLATE)", async () => {
    vi.stubEnv("VITE_TRANSLATE", "");
    const error = await translateTexts("pt-en", ["Olá"]).catch((error: unknown) => error);
    expect((error as TranslateError).reason).toBe("off");
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
