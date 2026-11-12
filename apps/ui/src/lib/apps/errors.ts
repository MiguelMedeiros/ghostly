import type { AppStoreSummary } from "@ghostly/browser/engine/apps";
import type { Translate, TranslationKey } from "../../contexts/I18nContext";
import { date } from "../identities";
import { problemLine } from "../problemText";
import { LOCKED } from "./open";

/*
 * The apps calls' errors start with their code (`<code>: words`, engine/apps.ts and appFetch.ts). The ones a person can
 * meet are said in the app's language; any other in a few words, its English behind the ⓘ where there is one.
 */
const KEYS: Record<string, TranslationKey> = {
  host: "apps.errors.host",
  "github-link": "apps.errors.githubLink",
  "private-link": "apps.errors.privateLink",
  offline: "apps.errors.offline",
  runner: "apps.errors.runner",
  status: "apps.errors.status",
  network: "apps.errors.network",
  slow: "apps.errors.slow",
  "too-large": "apps.errors.tooLarge",
  "other-app": "apps.errors.otherApp",
  rollback: "apps.errors.rollback",
  equivocation: "apps.errors.equivocation",
  expired: "apps.errors.expired",
  revoked: "apps.errors.revoked",
  removed: "apps.errors.removed",
  "not-listed": "apps.errors.notListed",
  unlisted: "apps.errors.unlistedVersion",
  "permissions-changed": "apps.errors.permissionsChanged",
  "store-key": "apps.errors.storeKey",
  "bad-signature": "apps.errors.notSigned",
  "signature-key": "apps.errors.notSigned",
  "bad-signature-statement": "apps.errors.notSigned",
  "needs-files": "apps.errors.needsFiles",
  // Get its files found no link holding the installed version (AppInstallDialog.tsx): nothing was fetched.
  "files-not-found": "apps.errors.filesNotFound",
  // Its stored files are not what was installed: the engine dropped them, and Get its files fetches them again.
  damaged: "apps.errors.damaged",
  storage: "apps.errors.storage",
};

/**
 * A store's list held older or too large: said of the store's list, not of an app's version. One dated further ahead
 * than this device's clock allows names the clock, the one thing the person can fix.
 */
const STORE_KEYS: Record<string, TranslationKey> = {
  rollback: "apps.store.rollback",
  "too-large": "apps.store.tooLarge",
  "expires-too-far": "apps.store.clockLate",
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

/**
 * An error of reading or adding a store (Add): a store refused (not JSON, a bad field, a bad signature) says the link holds
 * no valid store, its refusal as it came behind the ⓘ, rather than an app Ghostly won't install. An older or too large
 * list is said of the store.
 */
export function appStoreErrorView(error: unknown, t: Translate): AppErrorView {
  const code = appErrorCode(error);
  if (code && STORE_KEYS[code]) return { text: t(STORE_KEYS[code]) };
  if (!code || (KEYS[code] && KEYS[code] !== "apps.errors.notSigned")) return appErrorView(error, t);
  return { text: t("apps.errors.notStore"), info: error instanceof Error ? error.message : String(error) };
}

/**
 * Why a store's last read failed, as its block on the Apps page says it: the store signed two lists under one number
 * (kept marked until a newer list comes), else the read's code in the words of an error of reading it.
 */
export function appStoreProblemText(store: Pick<AppStoreSummary, "problem" | "problemStatus" | "equivocation">, t: Translate): string | null {
  if (store.equivocation) return t("apps.store.equivocation", { date: date(Math.floor(store.equivocation.at / 1000), t.language) });
  if (!store.problem) return null;
  // As the engine's fetch error says it: `status: The host answered 503`.
  return appStoreErrorView(new Error(`${store.problem}: ${store.problemStatus !== undefined ? `The host answered ${store.problemStatus}` : ""}`), t).text;
}

export function appErrorText(error: unknown, t: Translate): string {
  // An Open the profile's lock overtook (open.ts): nothing failed, it opens again once unlocked.
  if ((error instanceof Error ? error.message : error) === LOCKED) return t("apps.errors.locked");
  const code = appErrorCode(error);
  // The host's own trouble (an outage, a rate limit) is not a wrong link: trying again later may work.
  const status = code === "status" ? Number(/\b(\d{3})\b/.exec(error instanceof Error ? error.message : String(error))?.[1]) : 0;
  if (status >= 500 || status === 429) return t("apps.errors.hostProblem", { status });
  const key = code ? KEYS[code] : undefined;
  if (key) return t(key);
  // A refusal of the bundle or the index (a bound, a hash, the format): said in a few words, its reason in the ⓘ
  // (appErrorView); any other error as a notice says it (lib/problemText.ts), never the engine's English.
  return code ? t("apps.errors.refused") : problemLine(error, t);
}
