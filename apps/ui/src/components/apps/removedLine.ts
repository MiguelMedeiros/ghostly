import type { Translate } from "../../contexts/I18nContext";

/**
 * "Removed by <store>: <reason>" (a store's listing, an app's screens) in the page's direction, the store's name and its
 * reason each isolated in their own (an Arabic reason in an English app). The line's `dir="auto"` took a Hebrew store's
 * direction where the language starts with its name (Japanese), and a Hebrew name and reason, not isolated, drew the
 * reason first.
 */
export const removedLine = (store: string, reason: string, t: Translate) => t("apps.install.removed", { store: `\u2068${store}\u2069`, reason: `\u2068${reason}\u2069` });
