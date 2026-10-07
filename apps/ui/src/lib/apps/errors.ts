import type { Translate, TranslationKey } from "../../contexts/I18nContext";
import { problemLine } from "../problemText";

/*
 * The apps calls' errors start with their code (`<code>: words`, engine/apps.ts and appFetch.ts). The ones a person can
 * meet are said in the app's language; any other in a few words, its English behind the ⓘ where there is one.
 */
const KEYS: Record<string, TranslationKey> = {
  host: "apps.errors.host",
  "github-link": "apps.errors.githubLink",
  offline: "apps.errors.offline",
  status: "apps.errors.status",
  network: "apps.errors.network",
  "too-large": "apps.errors.tooLarge",
  "other-app": "apps.errors.otherApp",
  rollback: "apps.errors.rollback",
  equivocation: "apps.errors.equivocation",
  expired: "apps.errors.expired",
  revoked: "apps.errors.revoked",
  removed: "apps.errors.removed",
  "not-listed": "apps.errors.notListed",
  "store-key": "apps.errors.storeKey",
  "bad-signature": "apps.errors.notSigned",
  "signature-key": "apps.errors.notSigned",
  "bad-signature-statement": "apps.errors.notSigned",
  "needs-files": "apps.errors.needsFiles",
  storage: "apps.errors.storage",
};

/** The longer story behind an ⓘ beside an error's line, for the errors that have one. */
const INFO: Record<string, TranslationKey> = {
  storage: "apps.errors.storageInfo",
};

/** The code of an apps error, or null. */
export function appErrorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^([a-z][a-z-]*): /.exec(text)?.[1] ?? null;
}

/** An error as a dialog shows it: its line, and the ⓘ's text when it has one. */
export interface AppErrorView { text: string; info?: string }

export function appErrorView(error: unknown, t: Translate): AppErrorView {
  const code = appErrorCode(error);
  const info = code ? INFO[code] : undefined;
  // A refusal the app has no words for: what was refused (a bound, a hash, the format) is behind the ⓘ, as it came.
  const refused = code && !KEYS[code] ? (error instanceof Error ? error.message : String(error)).slice(code.length + 2) : undefined;
  return { text: appErrorText(error, t), ...(info ? { info: t(info) } : refused ? { info: refused } : {}) };
}

export function appErrorText(error: unknown, t: Translate): string {
  const code = appErrorCode(error);
  const key = code ? KEYS[code] : undefined;
  if (key) return t(key);
  // A refusal of the bundle or the index (a bound, a hash, the format): said in a few words, its reason in the ⓘ
  // (appErrorView); any other error as a notice says it (lib/problemText.ts), never the engine's English.
  return code ? t("apps.errors.refused") : problemLine(error, t);
}
