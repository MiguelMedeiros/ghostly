import type { AppRunStatus } from "@ghostly/browser/engine/apps";
import type { Translate } from "../../contexts/I18nContext";
import { removedLine } from "./removedLine";

/**
 * Why an installed version cannot run, in one line of text: its publisher revoked it (with the publisher's reason, its
 * own text, isolated) or stores removed it (each store's line). Null while it may run.
 */
export function stopReason(run: AppRunStatus, t: Translate): string | null {
  if (run.status === "revoked") return run.reason ? t("apps.install.revokedReason", { reason: `\u2068${run.reason}\u2069` }) : t("apps.install.revoked");
  if (run.status === "removed") return run.by.map((b) => removedLine(b.name, b.reason, t)).join(" ");
  return null;
}

/**
 * "Chess stopped. Its publisher revoked this version: …", said politely when an update check or a store stops an
 * installed app: its row turning to Stopped, its Open going, were seen and never heard. The title is isolated in its own
 * direction, as on the app's other lines.
 */
export function stoppedSaid(title: string, run: AppRunStatus, t: Translate): string {
  const why = stopReason(run, t);
  const stopped = t("apps.app.stoppedSaid", { title: `\u2068${title}\u2069` });
  return why ? `${stopped} ${why}` : stopped;
}
