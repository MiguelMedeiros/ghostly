import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import runtimePackage from "../../../native/translation/package.json" with { type: "json" };
import { translateFrom, type DetectLanguages } from "../../../apps/ui/src/lib/translateWhich";
import { CliError } from "./errors";
import type { GhostlyEvent } from "./events";

/**
 * `--translate <lang>` (docs/AUTO-TRANSLATE.md): received messages get `translation: { from, text }`, made on this machine
 * by the translation runtime (native/translation) the Desktop downloads: `bare runtime.mjs <models>`, one JSON line per
 * request. Which messages, and from which language, is the app's rule (translateWhich.ts): only a contact's or a member's
 * text, never mine, and only what the detector is sure of. Nothing is fetched here. A message's text goes to the runtime
 * only, never to stderr: what is said there is the runtime's own word or a path.
 */

/** The runtime this CLI starts, in `<home>/translation-runtime/<version>/`; models in `<home>/translation-models/<pair>/`, as on Desktop. */
export const RUNTIME_VERSION: string = runtimePackage.version;

export function translationPaths(home: string): { runtime: string; models: string } {
  return { runtime: join(home, "translation-runtime", RUNTIME_VERSION), models: join(home, "translation-models") };
}

/** `--translate`'s language, checked before anything starts: an ISO 639 code, as the runtime's pairs take. */
export function translateTarget(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z]{2,3}$/.test(value)) throw new CliError("usage", `--translate takes a language code (en, pt, es, ...), not ${JSON.stringify(value)}`);
  return value;
}

/**
 * The language detector (`@qvac/langdetect-text`'s `detectMultiple`), which the rule takes as a parameter. It is not a
 * dependency of the CLI yet: until it is, `--translate` says so once and prints messages as they are.
 */
export async function loadDetector(): Promise<DetectLanguages | null> {
  return null;
}

/** What the CLI prints of a message, as far as translating it goes (views.ts' MessageJson). */
interface ShownMessage {
  chat?: string;
  from?: string;
  text?: unknown;
  file?: unknown;
  paymentId?: unknown;
  card?: unknown;
  event?: unknown;
  mentions?: { offset: number; length: number }[];
  translation?: { from: string; text: string };
}

export interface Translator {
  /** The message with `translation` when the rule says so and the runtime answered; else the same object. */
  message<T extends ShownMessage>(message: T): Promise<T & Pick<ShownMessage, "translation">>;
  /** The event with its message translated (a join notice is the app's line, not the contact's words). */
  event(event: GhostlyEvent): Promise<GhostlyEvent>;
  /** Ends the runtime's input: it unloads and exits. */
  close(): void;
}

export interface TranslatorOptions {
  home: string;
  to: string;
  detect: DetectLanguages | null;
  /** One line to stderr. */
  warn: (line: string) => void;
}

/** `events` and `chat history` with `--translate`: their events or messages one by one, oldest first, as `listen` takes them. */
export async function translateAnswer(answer: Record<string, unknown>, translator: Translator): Promise<Record<string, unknown>> {
  const each = async <T,>(list: T[], one: (item: T) => Promise<T>) => { const out: T[] = []; for (const item of list) out.push(await one(item)); return out; };
  if (Array.isArray(answer.events)) return { ...answer, events: await each(answer.events as GhostlyEvent[], translator.event) };
  if (Array.isArray(answer.messages)) return { ...answer, messages: await each(answer.messages as ShownMessage[], translator.message) };
  return answer;
}

type Answer = { id?: unknown; texts?: unknown; error?: unknown } | null;

/** A translator, or null when the detector or the runtime is not there: said once, and messages stay as they are. */
export function openTranslator({ home, to, detect, warn }: TranslatorOptions): Translator | null {
  const { runtime, models } = translationPaths(home);
  const bare = join(runtime, process.platform === "win32" ? "bare.exe" : "bare"), script = join(runtime, "runtime.mjs");
  // The detector first: without it no runtime or model helps, so nobody is sent to unpack one for nothing.
  if (!detect) {
    warn("ghostly: --translate cannot translate in this build of the CLI (it has no language detector yet): messages are printed untranslated");
    return null;
  }
  if (!existsSync(bare) || !existsSync(script)) {
    warn(`ghostly: no translation runtime in ${runtime}: messages are printed untranslated. Unpack runtime ${RUNTIME_VERSION} there and a model in ${join(models, "<from>-<to>")}`);
    return null;
  }

  let child: ChildProcessByStdio<Writable, Readable, null> | null = null, next = 0, closed = false, stopped = false;
  const waiting = new Map<number, (answer: Answer) => void>();
  const said = new Set<string>();
  const kill = () => child?.kill();

  // Started at the first message to translate, and kept for the ones after it (a model loads once).
  const start = () => {
    const started = spawn(bare, [script, models], { stdio: ["pipe", "pipe", "ignore"] });
    started.stdin.on("error", () => {});
    createInterface({ input: started.stdout }).on("line", (line) => {
      let answer: Answer;
      try { answer = JSON.parse(line) as Answer; } catch { return; }
      const id = answer?.id as number, done = waiting.get(id);
      waiting.delete(id);
      done?.(answer);
    });
    const gone = (why: string) => {
      if (stopped) return;
      stopped = true;
      child = null;
      if (!closed) warn(`ghostly: the translation runtime stopped (${why}): messages are printed untranslated from here`);
      for (const done of waiting.values()) done(null);
      waiting.clear();
    };
    started.on("error", (error) => gone(error.message));
    started.on("exit", (code, signal) => gone(signal ?? `exit ${code}`));
    process.once("exit", kill);
    return started;
  };

  const ask = (pair: string, text: string) => new Promise<string | null>((resolve) => {
    if (closed || stopped) return resolve(null);
    child ??= start();
    const id = ++next;
    waiting.set(id, (answer) => {
      const texts = answer?.texts;
      if (Array.isArray(texts) && typeof texts[0] === "string") return resolve(texts[0]);
      // The runtime's errors never carry the text ("Translation model not downloaded"): said once per pair.
      if (typeof answer?.error === "string" && !said.has(pair)) { said.add(pair); warn(`ghostly: no translation ${pair}: ${answer.error}`); }
      resolve(null);
    });
    child.stdin.write(JSON.stringify({ id, op: "translate", pair, texts: [text] }) + "\n");
  });

  const has = (pair: string) => existsSync(join(models, pair));
  // Straight into `to`, or through English: the runtime chains es-en and en-pt itself for es-pt.
  const canTranslate = (from: string) => has(`${from}-${to}`) || (from !== "en" && to !== "en" && has(`${from}-en`) && has(`en-${to}`));
  /** Per chat or group, the last language the others wrote with confidence: a short message is taken to be in it. */
  const languages = new Map<string, string>();

  async function message<T extends ShownMessage>(shown: T): Promise<T & Pick<ShownMessage, "translation">> {
    if (typeof shown?.text !== "string") return shown;
    const place = shown.chat ?? "";
    let which: Awaited<ReturnType<typeof translateFrom>>;
    try {
      which = await translateFrom({
        sender: shown.from === "peer" ? "peer" : "me", text: shown.text,
        file: shown.file, paymentId: shown.paymentId, card: shown.card, systemEvent: shown.event,
        mentions: shown.mentions?.map((m) => ({ o: m.offset, l: m.length })),
      } as unknown as Parameters<typeof translateFrom>[0], { appLanguage: to as Parameters<typeof translateFrom>[1]["appLanguage"], detect: detect!, canTranslate, chatLanguage: languages.get(place) });
    } catch { return shown; }
    const { from, detected } = which;
    if (detected) languages.set(place, detected);
    if (!from) return shown;
    const text = await ask(`${from}-${to}`, shown.text);
    // The same words back ("ok" taken as the chat's Portuguese) are no translation.
    return text === null || text.trim() === shown.text.trim() ? shown : { ...shown, translation: { from, text } };
  }

  return {
    message,
    async event(event) {
      const shown = event.message as ShownMessage | undefined;
      if (!shown || typeof shown !== "object" || event.type === "chat.joined") return event;
      const translated = await message(shown);
      return translated === shown ? event : { ...event, message: translated };
    },
    close() {
      closed = true;
      process.off("exit", kill);
      child?.stdin.end();
    },
  };
}
