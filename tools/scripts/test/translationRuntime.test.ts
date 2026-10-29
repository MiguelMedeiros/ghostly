import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeRuntimeFiles } from "../native-runtime-files.mjs";
import { MAX_LINE, MAX_MODELS, MAX_TEXTS, createRuntime, lineReader, modelFiles, pairFiles, parsePair } from "../../../native/translation/protocol.mjs";

/**
 * The translation runtime (native/translation): `bare runtime.mjs <models folder>` speaks one JSON line per request
 * over stdio, `{ id, op: "load" | "translate" | "unload", pair, texts }`, answered in order by `{ id, texts }`, `{ id }`
 * or `{ id, error }`. tools/scripts/prepare-translation-runtime.mjs builds it per platform into an archive the app
 * downloads with the first language model.
 */
const SOURCE = join(import.meta.dirname, "../../../native/translation");
const ROOT = "/models";
const join2 = (...parts: string[]) => parts.join("/");

type Opened = { from: string; to: string; files: Record<string, string> };

/** A runtime over a fake engine: it "translates" by tagging each text with its pair, and records what happened. */
function fake({ missing = [] as string[], failOpen = false, failTranslate = "" } = {}) {
  const events: string[] = [];
  const runtime = createRuntime({
    root: ROOT,
    join: join2,
    exists: (path: string) => !missing.some((name) => path.includes(name)),
    open: async ({ from, to, files }: Opened) => {
      events.push(`open ${from}-${to}${files.pivotModel ? " pivot" : ""}`);
      if (failOpen) throw new Error("bad model file");
      return {
        translate: async (texts: string[]) => {
          if (failTranslate) throw new Error(failTranslate);
          return texts.map((text) => `[${from}>${to}] ${text}`);
        },
        close: async () => void events.push(`close ${from}-${to}`),
      };
    },
  });
  const ask = (request: unknown) => runtime.handle(typeof request === "string" ? request : JSON.stringify(request));
  return { runtime, ask, events };
}

describe("a pair", () => {
  it("is <from>-<to> in two- or three-letter codes, two different languages", () => {
    expect(parsePair("pt-en")).toEqual({ from: "pt", to: "en" });
    expect(parsePair("fil-en")).toEqual({ from: "fil", to: "en" });
    for (const bad of ["pten", "pt-en-es", "pt-pt", "PT-en", "pt-", "-en", "../x-en", "pt-en/..", "p-en", 7, null, undefined]) expect(parsePair(bad), String(bad)).toBeNull();
  });

  it("reads Mozilla's file names: one shared vocabulary, or one per side into Chinese, Japanese and Korean", () => {
    expect(modelFiles("pt", "en")).toEqual({ model: "model.pten.intgemm.alphas.bin", srcVocab: "vocab.pten.spm", dstVocab: "vocab.pten.spm" });
    expect(modelFiles("en", "ja")).toEqual({ model: "model.enja.intgemm.alphas.bin", srcVocab: "srcvocab.enja.spm", dstVocab: "trgvocab.enja.spm" });
    expect(modelFiles("zh", "en")).toEqual({ model: "model.zhen.intgemm.alphas.bin", srcVocab: "vocab.zhen.spm", dstVocab: "vocab.zhen.spm" });
  });

  it("names exactly the files the Desktop app downloads for every pinned pair", () => {
    const pinned: Record<string, { name: string }[]> = JSON.parse(readFileSync(join(SOURCE, "../../apps/desktop/src/translate_models.json"), "utf8"));
    for (const [pair, files] of Object.entries(pinned)) {
      const { from, to } = parsePair(pair)!;
      const named = new Set(Object.values(modelFiles(from, to)));
      expect([...named].sort(), pair).toEqual(files.map((f) => f.name).sort());
    }
  });

  it("with English on one side is one model in its folder; with English on neither, two chained through English", () => {
    expect(pairFiles(ROOT, { from: "en", to: "it" }, join2)).toEqual({
      model: "/models/en-it/model.enit.intgemm.alphas.bin",
      srcVocab: "/models/en-it/vocab.enit.spm",
      dstVocab: "/models/en-it/vocab.enit.spm",
    });
    expect(pairFiles(ROOT, { from: "es", to: "pt" }, join2)).toEqual({
      model: "/models/es-en/model.esen.intgemm.alphas.bin",
      srcVocab: "/models/es-en/vocab.esen.spm",
      dstVocab: "/models/es-en/vocab.esen.spm",
      pivotModel: "/models/en-pt/model.enpt.intgemm.alphas.bin",
      pivotSrcVocab: "/models/en-pt/vocab.enpt.spm",
      pivotDstVocab: "/models/en-pt/vocab.enpt.spm",
    });
  });
});

describe("the protocol", () => {
  it("translates a batch in order, loading the pair on the first request and only then", async () => {
    const { ask, events } = fake();
    expect(await ask({ id: 1, op: "translate", pair: "pt-en", texts: ["Olá", "tudo bem?"] })).toEqual({ id: 1, texts: ["[pt>en] Olá", "[pt>en] tudo bem?"] });
    expect(await ask({ id: "b", op: "translate", pair: "pt-en", texts: ["oi"] })).toEqual({ id: "b", texts: ["[pt>en] oi"] });
    expect(events).toEqual(["open pt-en"]);
  });

  it("answers in the order asked, each request after the one before", async () => {
    const { ask } = fake();
    const answers = await Promise.all([ask({ id: 1, op: "load", pair: "pt-en" }), ask({ id: 2, op: "translate", pair: "es-pt", texts: ["hola"] }), ask("nope"), ask({ id: 3, op: "unload" })]);
    expect(answers).toEqual([{ id: 1 }, { id: 2, texts: ["[es>pt] hola"] }, { id: null, error: "Invalid request" }, { id: 3 }]);
  });

  it(`keeps at most ${MAX_MODELS} models, unloading the one used least recently for a third`, async () => {
    const { ask, events } = fake();
    await ask({ id: 1, op: "load", pair: "pt-en" });
    await ask({ id: 2, op: "load", pair: "en-it" });
    await ask({ id: 3, op: "translate", pair: "pt-en", texts: ["a"] });
    await ask({ id: 4, op: "load", pair: "es-pt" });
    expect(events).toEqual(["open pt-en", "open en-it", "close en-it", "open es-pt pivot"]);
  });

  it("unloads one pair, or every pair", async () => {
    const { ask, events } = fake();
    await ask({ id: 1, op: "load", pair: "pt-en" });
    await ask({ id: 2, op: "load", pair: "en-pt" });
    expect(await ask({ id: 3, op: "unload", pair: "pt-en" })).toEqual({ id: 3 });
    expect(await ask({ id: 4, op: "unload", pair: "fr-en" })).toEqual({ id: 4 });
    expect(await ask({ id: 5, op: "unload" })).toEqual({ id: 5 });
    expect(events).toEqual(["open pt-en", "open en-pt", "close pt-en", "close en-pt"]);
  });

  it("closes what is loaded when its input ends", async () => {
    const { ask, runtime, events } = fake();
    await ask({ id: 1, op: "load", pair: "pt-en" });
    await runtime.close();
    expect(events).toEqual(["open pt-en", "close pt-en"]);
  });

  it("says a model is not downloaded, without opening anything, when any of its files is missing", async () => {
    const { ask, events } = fake({ missing: ["en-pt/vocab"] });
    expect(await ask({ id: 1, op: "translate", pair: "pt-en", texts: ["x"] })).toEqual({ id: 1, texts: ["[pt>en] x"] });
    expect(await ask({ id: 2, op: "translate", pair: "es-pt", texts: ["x"] })).toEqual({ id: 2, error: "Translation model not downloaded" });
    expect(await ask({ id: 3, op: "load", pair: "en-pt" })).toEqual({ id: 3, error: "Translation model not downloaded" });
    expect(events).toEqual(["open pt-en"]);
  });

  it("refuses what is not a request, and answers it with the id it had", async () => {
    const { ask } = fake();
    expect(await ask("{")).toEqual({ id: null, error: "Invalid request" });
    expect(await ask("[1]")).toEqual({ id: null, error: "Invalid request" });
    expect(await ask({ op: "load", pair: "pt-en" })).toEqual({ id: null, error: "Invalid request" });
    expect(await ask({ id: { x: 1 }, op: "load", pair: "pt-en" })).toEqual({ id: null, error: "Invalid request" });
    expect(await ask({ id: 1, op: "fetch", pair: "pt-en" })).toEqual({ id: 1, error: "Unknown request" });
    expect(await ask({ id: 2, op: "translate", pair: "../../etc-en", texts: ["x"] })).toEqual({ id: 2, error: "Unknown language pair" });
    expect(await ask({ id: 3, op: "translate", pair: "pt-en", texts: "x" })).toEqual({ id: 3, error: "Invalid texts" });
    expect(await ask({ id: 4, op: "translate", pair: "pt-en", texts: ["x", 5] })).toEqual({ id: 4, error: "Invalid texts" });
    expect(await ask({ id: 5, op: "translate", pair: "pt-en", texts: Array(MAX_TEXTS + 1).fill("x") })).toEqual({ id: 5, error: "Invalid texts" });
    expect(await ask({ id: 6, op: "translate", pair: "pt-en", texts: [] })).toEqual({ id: 6, texts: [] });
  });

  it("never puts a message's text in an error, and retries a model that failed to open", async () => {
    const translating = fake({ failTranslate: "could not translate 'my secret message'" });
    expect(await translating.ask({ id: 1, op: "translate", pair: "pt-en", texts: ["my secret message"] })).toEqual({ id: 1, error: "Translation failed" });
    const opening = fake({ failOpen: true });
    expect(await opening.ask({ id: 1, op: "load", pair: "pt-en" })).toEqual({ id: 1, error: "Translation failed" });
    expect(await opening.ask({ id: 2, op: "load", pair: "pt-en" })).toEqual({ id: 2, error: "Translation failed" });
    expect(opening.events).toEqual(["open pt-en", "open pt-en"]);
  });
});

describe("its input", () => {
  it("is read in lines, a character split between two chunks kept whole", () => {
    const lines: string[] = [];
    const read = lineReader((line: string) => lines.push(line), () => lines.push("TOO LONG"));
    const bytes = Buffer.from('{"t":"Olá"}\n\n{"t":"日本"}\n{"t":');
    const split = bytes.indexOf(Buffer.from("á")) + 1;
    read(bytes.subarray(0, split));
    read(bytes.subarray(split));
    read(Buffer.from('"x"}\n'));
    expect(lines).toEqual(['{"t":"Olá"}', '{"t":"日本"}', '{"t":"x"}']);
  });

  it(`drops a line over ${MAX_LINE} bytes, says so once, and reads the next one`, () => {
    const lines: string[] = [];
    const read = lineReader((line: string) => lines.push(line.slice(0, 20)), () => lines.push("TOO LONG"));
    const big = Buffer.alloc(MAX_LINE / 2, "a");
    read(big);
    read(big);
    read(big);
    read(Buffer.from('aaa\n{"id":1}\n'));
    read(Buffer.concat([Buffer.alloc(MAX_LINE + 1, "b"), Buffer.from('\n{"id":2}\n')]));
    expect(lines).toEqual(["TOO LONG", '{"id":1}', "TOO LONG", '{"id":2}']);
  });

  it("answers a dropped line in its place among the others", async () => {
    const { runtime } = fake();
    const answers = await Promise.all([runtime.handle('{"id":1,"op":"unload"}'), runtime.tooLong(), runtime.handle('{"id":2,"op":"unload"}')]);
    expect(answers).toEqual([{ id: 1 }, { id: null, error: "Request too long" }, { id: 2 }]);
  });
});

it("ships the script and every module it imports, flat", () => {
  expect(nativeRuntimeFiles(SOURCE, "runtime.mjs")).toEqual(["package.json", "package-lock.json", "protocol.mjs", "runtime.mjs"]);
});

it("pins the addon and the runtime, and its lockfile holds no install script", () => {
  const pkg = JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8"));
  for (const version of Object.values(pkg.dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(readFileSync(join(SOURCE, "package-lock.json"), "utf8"));
  expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
  expect(Object.entries(lock.packages).filter(([, entry]) => (entry as { hasInstallScript?: boolean }).hasInstallScript)).toEqual([]);
});

/**
 * The runtime this host built (`node tools/scripts/prepare-translation-runtime.mjs`), on a real Bergamot model from
 * Mozilla's CDN: the pt-en files Firefox reads, checked against the SHA-256 Mozilla's records (and QVAC's registry)
 * pin. Skipped where no runtime was built: CI does not build one for the unit tests.
 */
const PLATFORM = `${process.platform}-${process.arch}`;
const BUILT = join(SOURCE, "dist", `ghostly-translation-runtime-${JSON.parse(readFileSync(join(SOURCE, "package.json"), "utf8")).version}-${PLATFORM}`);
const MODELS = join(SOURCE, "dist", "models");
const CDN = "https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models";
const PT_EN = [
  { name: "model.pten.intgemm.alphas.bin", url: `${CDN}/6a2cb71f-cf08-431a-a4a2-22e450750408.bin`, sha256: "7b854f1ec5a485dd33efd7c1bc01dd7d5a57f566957c5e47722af333f0ce9157" },
  { name: "vocab.pten.spm", url: `${CDN}/9f79e7dc-18ca-4ee7-ad79-2935e46b7d9a.spm`, sha256: "d9f46182823d5bbc84201252b2dfcac28f63e561f0ec827ed858f241864c9def" },
];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function modelPtEn() {
  const dir = join(MODELS, "pt-en");
  mkdirSync(dir, { recursive: true });
  for (const file of PT_EN) {
    const path = join(dir, file.name);
    if (existsSync(path) && sha256(readFileSync(path)) === file.sha256) continue;
    const response = await fetch(file.url);
    expect(response.ok, file.url).toBe(true);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(sha256(bytes), file.name).toBe(file.sha256);
    writeFileSync(path, bytes);
  }
}

/** The archive the app will download, checked against the SHA-256 written beside it and unpacked in a folder of its own. */
function unpacked() {
  const archive = `${BUILT}.tar.gz`;
  const [pinned, name] = readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/);
  expect(name).toBe(basename(archive));
  expect(sha256(readFileSync(archive))).toBe(pinned);
  const dir = mkdtempSync(join(tmpdir(), "ghostly-translation-runtime-"));
  // The app runs Windows' own tar (System32 comes before PATH there). A job's bash puts Git's GNU tar first, which
  // reads "D:\..." as a remote host and fails, so Windows names System32's.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xzf", archive, "-C", dir]);
  return join(dir, basename(BUILT));
}

/** Starts a runtime and returns `ask(request)`, which resolves to the answer with the request's id. */
function start(dir: string) {
  const child = spawn(join(dir, process.platform === "win32" ? "bare.exe" : "bare"), [join(dir, "runtime.mjs"), MODELS], { stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<unknown, (answer: unknown) => void>();
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  child.stdout.on("data", (chunk) => {
    out += chunk;
    for (let at = out.indexOf("\n"); at >= 0; at = out.indexOf("\n")) {
      const answer = JSON.parse(out.slice(0, at));
      out = out.slice(at + 1);
      waiting.get(answer.id)?.(answer);
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  // A runtime that dies answers nothing: the request fails with what it said instead of waiting out the timeout.
  const ask = (request: { id: number }) => new Promise((resolve, reject) => {
    waiting.set(request.id, resolve);
    void exited.then((code) => reject(new Error(`The runtime exited (${code}): ${err}`)));
    child.stdin.write(JSON.stringify(request) + "\n");
  });
  return { ask, end: () => child.stdin.end(), exited, stderr: () => err };
}

it.skipIf(!existsSync(`${BUILT}.tar.gz`))(`translates pt-en on this host (${PLATFORM}) with the runtime's archive and Mozilla's model`, { timeout: 120_000 }, async () => {
  await modelPtEn();
  const dir = unpacked();
  const runtime = start(dir);
  // Nothing but the protocol's files, the addon's graph and `bare`: no GPU backend, no other platform, no bare-runtime.
  expect(readdirSync(dir).sort()).toEqual(["bare", "node_modules", "package-lock.json", "package.json", "protocol.mjs", "runtime.mjs"].map((name) => (name === "bare" && process.platform === "win32" ? "bare.exe" : name)).sort());
  expect(existsSync(join(dir, "node_modules/bare-runtime"))).toBe(false);
  expect(readdirSync(join(dir, "node_modules/@qvac/translation-nmtcpp/prebuilds"))).toEqual([PLATFORM]);
  expect(
    readdirSync(join(dir, "node_modules/@qvac"), { recursive: true, encoding: "utf8" }).filter((path) => /ggml-(cuda|hip|vulkan|rpc)/.test(path)),
  ).toEqual([]);
  expect(await runtime.ask({ id: 1, op: "translate", pair: "pt-en", texts: ["Olá, tudo bem?"] }), runtime.stderr()).toEqual({ id: 1, texts: [expect.stringMatching(/^(hey|hi|hello)\b.*\b(what's up|how are you)\?$/i)] });
  expect(await runtime.ask({ id: 2, op: "translate", pair: "en-pt", texts: ["Hi"] })).toEqual({ id: 2, error: "Translation model not downloaded" });
  expect(await runtime.ask({ id: 3, op: "unload" })).toEqual({ id: 3 });
  runtime.end();
  expect(await runtime.exited).toBe(0);
  rmSync(dirname(dir), { recursive: true, force: true });
});
