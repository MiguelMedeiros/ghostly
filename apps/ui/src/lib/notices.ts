import type { Translate, TranslationKey } from "../contexts/I18nContext";
import type { Problem } from "./problemText";

/*
 * The app's own lines as notices (components/ui/Notice.tsx): a key is the title, and a key that has a next line names
 * it here, beside it, so the type checker sees both (the error copy pass keeps each old key as the title and adds a
 * sibling for what to do or what is safe).
 */
const NEXT: Partial<Record<TranslationKey, TranslationKey>> = {
  "devices.fail.elsewhere": "devices.fail.elsewhereNext",
  "devices.fail.inUse": "devices.fail.inUseNext",
  "devices.fail.unreached": "devices.fail.unreachedNext",
  "devices.handoff.fail.mainnet": "devices.handoff.fail.mainnetNext",
  "devices.handoff.fail.stalled": "devices.handoff.fail.stalledNext",
  "devices.takeover.fail.noCopy": "devices.takeover.fail.noCopyNext",
  "devices.takeover.fail.noPassword": "devices.takeover.fail.noPasswordNext",
  "profile.backups.protection.mainnet": "profile.backups.protection.mainnetNext",
  "profile.backups.protection.warning": "profile.backups.protection.warningNext",
};

/** `key` as an error notice: its words the title, and its next line when it has one. */
export function said(key: TranslationKey, t: Translate, params?: Record<string, string | number>): Problem {
  const next = NEXT[key];
  return { tone: "error", title: t(key, params), ...(next && { next: t(next, params) }) };
}

/** `key`'s next line, when it has one. */
export const nextOf = (key: TranslationKey, t: Translate, params?: Record<string, string | number>): string | undefined => {
  const next = NEXT[key];
  return next && t(next, params);
};
