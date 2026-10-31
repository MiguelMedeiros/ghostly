import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { GhostlyEvent } from "../src/events";
import { eventHandler } from "../src/listen";
import { openTranslator, RUNTIME_VERSION, translateAnswer, translateTarget, translationPaths, type Translator } from "../src/translate";
import { ghostly, home } from "./support/cli";

/**
 * `--translate <lang>`: a received message gets `translation: { from, text }` from the translation runtime under the
 * data folder, by the app's rule of which messages (translateWhich.ts); mine, files, the app's own lines and what the
 * detector is not sure of stay as they are. A fake runtime (Node, same stdio protocol) stands in for Bare.
 */

/** Answers `translate` with `<pair>|<its pid>|<text>`, logs each start and each end, and fails a pair it has no model for. */
const FAKE_RUNTIME = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.argv[2] + "/../runtime.log";
appendFileSync(log, "start\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, op, pair, texts } = JSON.parse(line);
  if (op !== "translate") return process.stdout.write(JSON.stringify({ id }) + "\\n");
  if (texts[0].startsWith("Morre agora")) process.exit(3);
  if (texts[0] === "ok") return process.stdout.write(JSON.stringify({ id, texts }) + "\\n");
  if (pair === "es-en") return process.stdout.write(JSON.stringify({ id, error: "Translation model not downloaded" }) + "\\n");
  process.stdout.write(JSON.stringify({ id, texts: texts.map((t) => pair + "|" + process.pid + "|" + t) }) + "\\n");
}).on("close", () => { appendFileSync(log, "end\\n"); process.exit(0); });
`;

/** A data folder with the fake runtime and models for pt-en and es-en (and none for fr). */
function fakeHome(): string {
  const dir = home("translate");
  const { runtime, models } = translationPaths(dir);
  mkdirSync(runtime, { recursive: true });
  // `bare runtime.mjs <models>`: here Node runs the script.
  writeFileSync(join(runtime, "bare"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(runtime, "bare"), 0o755);
  writeFileSync(join(runtime, "runtime.mjs"), FAKE_RUNTIME);
  for (const pair of ["pt-en", "es-en"]) mkdirSync(join(models, pair), { recursive: true });
  return dir;
}
const runtimeLog = (dir: string) => { const path = join(dir, "runtime.log"); return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : []; };

/** The detector's word on a few test lines: Portuguese, Spanish, French, English; anything else undetermined. */
const detect = (text: string) => {
  if (/\b(você|obrigado|tudo|amanhã|chego)\b/i.test(text)) return [{ code: "pt", probability: 0.92 }];
  if (/\b(gracias|mañana|cuándo)\b/i.test(text)) return [{ code: "es", probability: 0.9 }];
  if (/\b(merci|demain|bonjour)\b/i.test(text)) return [{ code: "fr", probability: 0.9 }];
  if (/\b(the|see|you|tomorrow)\b/i.test(text)) return [{ code: "en", probability: 0.95 }];
  return [{ code: "und", probability: 0 }];
};

const open = (dir: string, warned: string[] = []) => openTranslator({ home: dir, to: "en", detect, warn: (line) => warned.push(line) })!;
const msg = (text: string, fields: Record<string, unknown> = {}) => ({ id: `m${text.length}`, chat: "chat1", from: "peer", text, timestamp: 4, delivery: null, deliveryError: null, via: "datalink", nick: "Ana", ...fields });
let seq = 0;
const received = (text: string, fields: Record<string, unknown> = {}, type = "message.received"): GhostlyEvent =>
  ({ seq: ++seq, id: `${type}:chat1:${seq}`, type, at: 5, chat: "chat1", message: msg(text, fields) });
const translated = (pair: string, text: string) => expect.stringMatching(new RegExp(`^${pair}\\|\\d+\\|${text.replace(/[?.]/g, "\\$&")}$`));

describe("a received message with --translate", () => {
  it("gets translation: { from, text } from the runtime, which one process gives for every message", async () => {
    const dir = fakeHome(), translator = open(dir);
    const first = await translator.message(msg("Chego aí em 10 minutos, tudo bem?"));
    const second = await translator.message(msg("Obrigado por tudo, até amanhã", { id: "m2" }));
    expect(first).toEqual({ ...msg("Chego aí em 10 minutos, tudo bem?"), translation: { from: "pt", text: translated("pt-en", "Chego aí em 10 minutos, tudo bem?") } });
    expect(second.translation).toEqual({ from: "pt", text: translated("pt-en", "Obrigado por tudo, até amanhã") });
    // The same pid in both answers: the runtime started once and stayed.
    expect(first.translation!.text.split("|")[1]).toBe(second.translation!.text.split("|")[1]);
    expect(runtimeLog(dir)).toEqual(["start"]);
    translator.close();
    await expect.poll(() => runtimeLog(dir)).toEqual(["start", "end"]);
  });

  it("leaves mine, the app's own lines, files, payments, cards, the target language and the unsure as they were", async () => {
    const dir = fakeHome(), translator = open(dir);
    const kept = [
      msg("Chego aí em 10 minutos, tudo bem?", { from: "me" }),
      msg("Ana saiu do grupo, tudo bem", { from: "system", event: "left" }),
      msg("foto_você.jpg", { file: { id: "f1", name: "foto_você.jpg", size: 10, mime: "image/jpeg" } }),
      msg("Obrigado pelo pagamento de tudo", { paymentId: "p1" }),
      msg("Obrigado, tarefa de tudo", { card: { kind: "task" } }),
      msg("See you tomorrow at the station"),
      msg("hmmm okay lol"),
      msg("ok"),
      msg("12:30 👍 https://example.com/você"),
    ];
    for (const message of kept) expect(await translator.message(message)).toBe(message);
    // A language with no model (fr here) shows nothing either, and nothing started the runtime.
    expect(await translator.message(msg("Merci, à demain alors"))).not.toHaveProperty("translation");
    expect(runtimeLog(dir)).toEqual([]);
    translator.close();
  });

  it("takes a short message to be in the language the chat's others last wrote with confidence", async () => {
    const dir = fakeHome(), translator = open(dir);
    expect(await translator.message(msg("Sim"))).not.toHaveProperty("translation");
    await translator.message(msg("Obrigado por tudo, até amanhã"));
    expect((await translator.message(msg("Sim"))).translation).toEqual({ from: "pt", text: translated("pt-en", "Sim") });
    // What comes back as it went ("ok" read as the chat's Portuguese) is no translation.
    expect(await translator.message(msg("ok"))).not.toHaveProperty("translation");
    // Another chat has its own.
    expect(await translator.message(msg("Sim", { chat: "chat2" }))).not.toHaveProperty("translation");
    translator.close();
  });

  it("says a runtime error once per pair, never with the message's text, and prints the message as it is", async () => {
    const dir = fakeHome(), warned: string[] = [], translator = open(dir, warned);
    expect(await translator.message(msg("Gracias, hasta mañana amigo"))).not.toHaveProperty("translation");
    expect(await translator.message(msg("¿Cuándo llegas mañana?"))).not.toHaveProperty("translation");
    expect(warned).toEqual(["ghostly: no translation es-en: Translation model not downloaded"]);
    translator.close();
  });

  it("goes on untranslated, said once, when the runtime dies", async () => {
    const dir = fakeHome(), warned: string[] = [], translator = open(dir, warned);
    // The fake exits on this text: as Bare would on a crash.
    const dying = msg("Morre agora, tudo bem?");
    expect(await translator.message(dying)).toBe(dying);
    const after = msg("Obrigado por tudo, até amanhã");
    expect(await translator.message(after)).toBe(after);
    expect(warned).toEqual(["ghostly: the translation runtime stopped (exit 3): messages are printed untranslated from here"]);
    translator.close();
  });
});

const NO_DETECTOR = "ghostly: --translate cannot translate in this build of the CLI (it has no language detector yet): messages are printed untranslated";

describe("without the runtime or the detector", () => {
  it("says so in one stderr line and gives no translator: the output stays as it is", () => {
    const warned: string[] = [], dir = home("translate-none");
    expect(openTranslator({ home: dir, to: "en", detect, warn: (line) => warned.push(line) })).toBeNull();
    expect(warned).toEqual([`ghostly: no translation runtime in ${translationPaths(dir).runtime}: messages are printed untranslated. Unpack runtime ${RUNTIME_VERSION} there and a model in ${join(translationPaths(dir).models, "<from>-<to>")}`]);
    const withRuntime = fakeHome(), said: string[] = [];
    expect(openTranslator({ home: withRuntime, to: "en", detect: null, warn: (line) => said.push(line) })).toBeNull();
    expect(said).toEqual([NO_DETECTOR]);
  });

  it("with no detector, says that first: nobody is sent to unpack a runtime that cannot help", () => {
    const warned: string[] = [];
    expect(openTranslator({ home: home("translate-neither"), to: "en", detect: null, warn: (line) => warned.push(line) })).toBeNull();
    expect(warned).toEqual([NO_DETECTOR]);
  });

  it("events and chat history --translate print what they print without it, and say why on stderr", async () => {
    const env = { GHOSTLY_HOME: home("translate-cli") };
    const plain = await ghostly(["events"], { env });
    const asked = await ghostly(["events", "--translate", "en"], { env });
    expect(asked.code).toBe(0);
    expect(asked.json).toEqual(plain.json);
    expect(asked.stderr).toContain(NO_DETECTOR);
    expect(asked.stderr).not.toContain("Unpack runtime");
    expect(asked.stderr.trim().split("\n").filter((line) => line.includes("translat"))).toHaveLength(1);
    const help = (await ghostly(["help", "listen"], { env })).stdout;
    expect(help).toContain("--translate <value>");
    expect(help).toContain("Not in this build yet (no language detector)");
  });

  it("--translate takes a language code, checked before anything starts", async () => {
    expect(translateTarget("pt")).toBe("pt");
    expect(translateTarget(undefined)).toBeUndefined();
    for (const bad of ["EN", "pt-BR", "", "english"]) expect(() => translateTarget(bad), bad).toThrow(/--translate takes a language code/);
    const result = await ghostly(["chat", "history", "bob", "--translate", "Portuguese"], { env: { GHOSTLY_HOME: home("translate-usage") } });
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "usage" } });
  });
});

describe("listen, events and chat history", () => {
  it("listen --translate --turns carries the translation under untrusted, the sender's words as the text is", async () => {
    const dir = fakeHome(), translator = open(dir), lines: string[] = [];
    const handle = eventHandler({ types: [], turns: true, print: true, write: (line) => lines.push(line), translate: translator.event });
    handle(received("Chego aí em 10 minutos, tudo bem?"));
    handle(received("Chego aí em 10 minutos, tudo bem?", { from: "me" }, "message.sent"));
    await handle.idle();
    const turns = lines.map((line) => JSON.parse(line));
    expect(turns).toHaveLength(1);
    expect(turns[0].untrusted).toMatchObject({ text: "Chego aí em 10 minutos, tudo bem?", translation: { from: "pt", text: translated("pt-en", "Chego aí em 10 minutos, tudo bem?") } });
    translator.close();
  });

  it("a join notice is the app's line: never translated", async () => {
    const dir = fakeHome(), translator = open(dir);
    const joined = received("👋 Ana entrou, tudo bem", {}, "chat.joined");
    expect(await translator.event(joined)).toBe(joined);
    translator.close();
  });

  it("an answer's events or messages are translated in order, the rest of it kept", async () => {
    const dir = fakeHome(), translator: Translator = open(dir);
    const events = await translateAnswer({ events: [received("Obrigado por tudo, até amanhã"), received("Sim")], lastSeq: 9 }, translator);
    expect(events.lastSeq).toBe(9);
    expect((events.events as GhostlyEvent[]).map((e) => (e.message as { translation?: { from: string } }).translation?.from)).toEqual(["pt", "pt"]);
    const history = await translateAnswer({ messages: [msg("See you tomorrow then"), msg("Obrigado por tudo, até amanhã")], more: false }, translator);
    expect(history.more).toBe(false);
    expect((history.messages as { translation?: unknown }[]).map((m) => !!m.translation)).toEqual([false, true]);
    translator.close();
  });
});

/**
 * The runtime slice 3's script builds (`node tools/scripts/prepare-translation-runtime.mjs`) with Mozilla's pt-en model,
 * as the Desktop will unpack them: skipped where none was built.
 */
const SOURCE = resolve(import.meta.dirname, "../../../native/translation/dist");
const ARCHIVE = join(SOURCE, `ghostly-translation-runtime-${RUNTIME_VERSION}-${process.platform}-${process.arch}.tar.gz`);
const MODEL = join(SOURCE, "models", "pt-en");
it.skipIf(!existsSync(ARCHIVE) || !existsSync(MODEL))("translates a received message with the real runtime and model", { timeout: 120_000 }, async () => {
  const [pinned] = readFileSync(`${ARCHIVE}.sha256`, "utf8").trim().split(/\s+/);
  expect(createHash("sha256").update(readFileSync(ARCHIVE)).digest("hex")).toBe(pinned);
  const dir = mkdtempSync(join(tmpdir(), "ghostly-translate-real-")), { runtime, models } = translationPaths(dir);
  mkdirSync(join(dir, "translation-runtime"), { recursive: true });
  execFileSync("tar", ["-xzf", ARCHIVE, "-C", join(dir, "translation-runtime")]);
  renameSync(join(dir, "translation-runtime", `ghostly-translation-runtime-${RUNTIME_VERSION}-${process.platform}-${process.arch}`), runtime);
  mkdirSync(models);
  symlinkSync(MODEL, join(models, "pt-en"));
  const warned: string[] = [], translator = open(dir, warned);
  const first = await translator.message(msg("Olá, tudo bem?"));
  expect(first.translation, warned.join("\n")).toEqual({ from: "pt", text: expect.stringMatching(/^(hey|hi|hello)\b.*\b(what's up|how are you)\?$/i) });
  expect((await translator.message(msg("Chego aí em 10 minutos, tudo bem?"))).translation?.text).toMatch(/10 minutes/);
  expect(await translator.message(msg("See you tomorrow then"))).not.toHaveProperty("translation");
  expect(warned).toEqual([]);
  translator.close();
  rmSync(dir, { recursive: true, force: true });
});
