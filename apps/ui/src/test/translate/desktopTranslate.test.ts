import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import {
  MAX_TEXTS, TranslateError, downloadBytes, downloadTranslation, removeTranslation, translateTexts, translationStatus,
  type TranslationStatus,
} from "../../desktop/translate";
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

/** The language models on this computer, as the page asks Rust for them (apps/desktop/src/translate_models.rs). */
describe("translation downloads on Desktop", () => {
  const status: TranslationStatus = {
    runtime: false,
    runtimeBytes: 52_000_000,
    pairs: [
      { pair: "en-pt", bytes: 32_378_513, downloaded: false },
      { pair: "pt-en", bytes: 32_378_513, downloaded: false },
      { pair: "en-es", bytes: 32_377_841, downloaded: true },
    ],
  };
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockResolvedValue(undefined);
    vi.stubEnv("VITE_TRANSLATE", "1");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("asks Rust for the status, a pair's download and its removal", async () => {
    tauri.invoke.mockResolvedValueOnce(status);
    expect(await translationStatus()).toEqual(status);
    await downloadTranslation("pt-en");
    await removeTranslation("en-es");
    expect(tauri.invoke.mock.calls).toEqual([
      ["translation_status", undefined],
      ["translation_download", { pair: "pt-en" }],
      ["translation_remove", { pair: "en-es" }],
    ]);
  });

  it("says when this computer has no runtime to download yet, and keeps Rust's words for the rest", async () => {
    for (const [said, reason] of [
      ["Translation is not available on this computer yet", "unavailable"],
      ["The download did not match its checksum", "failed"],
      ["The download did not finish", "failed"],
      ["Unknown language pair", "failed"],
    ] as const) {
      tauri.invoke.mockRejectedValueOnce(said);
      const error = await downloadTranslation("pt-en").catch((error: unknown) => error);
      expect((error as TranslateError).reason, said).toBe(reason);
      expect(rawError(error), said).toBe(said);
    }
  });

  it("counts what a download takes: the pairs not here yet, and the runtime when it is not", () => {
    expect(downloadBytes(status, ["pt-en", "en-pt"])).toBe(52_000_000 + 2 * 32_378_513);
    expect(downloadBytes(status, ["pt-en", "en-es"])).toBe(52_000_000 + 32_378_513);
    expect(downloadBytes({ ...status, runtime: true }, ["pt-en", "en-pt"])).toBe(2 * 32_378_513);
    expect(downloadBytes({ ...status, runtime: true }, ["en-es"])).toBe(0);
    // No runtime here and none to download: nothing to offer.
    expect(downloadBytes({ ...status, runtimeBytes: null }, ["pt-en"])).toBeNull();
    expect(downloadBytes({ ...status, runtime: true, runtimeBytes: null }, ["pt-en"])).toBe(32_378_513);
  });

  it("asks nothing in a build without translation (VITE_TRANSLATE)", async () => {
    vi.stubEnv("VITE_TRANSLATE", "");
    for (const call of [translationStatus, () => downloadTranslation("pt-en"), () => removeTranslation("pt-en")]) {
      const error = await call().catch((error: unknown) => error);
      expect((error as TranslateError).reason).toBe("off");
    }
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
