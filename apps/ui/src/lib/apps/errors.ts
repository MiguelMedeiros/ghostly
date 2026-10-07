import type { Translate, TranslationKey } from "../../contexts/I18nContext";

/*
 * The apps calls' errors start with their code (`<code>: words`, engine/apps.ts and appFetch.ts). The ones a person can
 * meet are said in the app's language; any other shows its English words, so nothing is hidden.
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
  "not-listed": "apps.errors.notListed",
  "store-key": "apps.errors.storeKey",
  "bad-signature": "apps.errors.notSigned",
  "signature-key": "apps.errors.notSigned",
  "bad-signature-statement": "apps.errors.notSigned",
  "needs-files": "apps.errors.needsFiles",
};

/** The code of an apps error, or null. */
export function appErrorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^([a-z][a-z-]*): /.exec(text)?.[1] ?? null;
}

export function appErrorText(error: unknown, t: Translate): string {
  const code = appErrorCode(error);
  const key = code ? KEYS[code] : undefined;
  if (key) return t(key);
  const text = error instanceof Error ? error.message : String(error);
  // A refusal of the bundle or the index (a bound, a hash, the format): the reason after the code, said plainly.
  return code ? t("apps.errors.refused", { reason: text.slice(code.length + 2) }) : text;
}
