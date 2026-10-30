import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { Row } from "../layout";
import { Button } from "../wallet/ui";
import { type Problem, problemText } from "../../lib/problemText";
import { Notice } from "../ui/Notice";

/** How long the question's Discard stays off after it shows: longer than a double click or a key pressed twice. */
const CONFIRM_SETTLE_MS = 500;

/**
 * "Only on this device" in Data and storage (WISP 06 § Installing the staged state): the copy of this profile a replaced
 * device kept when it took the profile back with Use here. What is in it never reached the profile; Discard removes it
 * for good, after a second press. `forks`: the device set's view of them (`DeviceSetView.forks`), as the page read it.
 */
export function ForkRows({ forks }: { forks?: readonly string[] }) {
  const { t } = useI18n();
  const [gone, setGone] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The question's Discard works only a moment after it shows: the second press of a double click (or a second Enter)
  // is not an answer. The focus goes to Cancel, and back to the row's Discard after Cancel.
  const [armed, setArmed] = useState(false);
  const [cancelled, setCancelled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  useEffect(() => {
    setArmed(false);
    if (confirming === null) return;
    const timer = setTimeout(() => setArmed(true), CONFIRM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  const discard = (database: string) => {
    setBusy(true); setError(null);
    void engine.call("deviceForkDiscard", { database })
      .then(() => { setConfirming(null); setGone((was) => [...was, database]); }, (e: unknown) => setError(problemText(e, t)))
      .finally(() => setBusy(false));
  };
  return <>{(forks ?? []).filter((database) => !gone.includes(database)).map((database) => (
    <Row key={database} testId="settings-fork" label={t("devices.fork.title")} hint={error && confirming === database ? <Notice problem={error} className="text-xs" /> : confirming === database ? t("devices.fork.confirm") : t("devices.fork.hint")} info={t("devices.fork.info")}>
      {confirming === database ? <>
        <Button key="confirm" variant="danger" data-testid="settings-fork-discard-confirm" disabled={busy || !armed} onClick={() => discard(database)}>{t("devices.fork.discard")}</Button>
        <Button key="cancel" data-testid="settings-fork-cancel" autoFocus disabled={busy} onClick={() => { setCancelled(database); setConfirming(null); }}>{t("common.cancel")}</Button>
      </> : <Button key="discard" variant="danger" data-testid="settings-fork-discard" autoFocus={cancelled === database} onClick={() => { setError(null); setCancelled(null); setConfirming(database); }}>{t("devices.fork.discard")}</Button>}
    </Row>
  ))}</>;
}
