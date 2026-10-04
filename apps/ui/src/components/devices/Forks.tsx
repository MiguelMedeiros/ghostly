import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { Row } from "../layout";
import { Button } from "../wallet/ui";
import { errorText } from "../../lib/errorText";

/**
 * "Only on this device" in Data and storage (WISP 06 § Installing the staged state): the copy of this profile a replaced
 * device kept when it took the profile back with Use here. What is in it never reached the profile; Discard removes it
 * for good, after a second press. `forks`: the device set's view of them (`DeviceSetView.forks`), as the page read it.
 */
export function ForkRows({ forks }: { forks?: readonly string[] }) {
  const { t } = useI18n();
  const [gone, setGone] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const discard = (database: string) => {
    setBusy(true); setError("");
    void engine.call("deviceForkDiscard", { database })
      .then(() => { setConfirming(null); setGone((was) => [...was, database]); }, (e: unknown) => setError(e instanceof Error ? errorText(e, t) : String(e)))
      .finally(() => setBusy(false));
  };
  return <>{(forks ?? []).filter((database) => !gone.includes(database)).map((database) => (
    <Row key={database} testId="settings-fork" label={t("devices.fork.title")} hint={error && confirming === database ? <span role="alert">{error}</span> : confirming === database ? t("devices.fork.confirm") : t("devices.fork.hint")} info={t("devices.fork.info")}>
      {confirming === database ? <>
        <Button variant="danger" data-testid="settings-fork-discard-confirm" disabled={busy} onClick={() => discard(database)}>{t("devices.fork.discard")}</Button>
        <Button disabled={busy} onClick={() => setConfirming(null)}>{t("common.cancel")}</Button>
      </> : <Button variant="danger" data-testid="settings-fork-discard" onClick={() => { setError(""); setConfirming(database); }}>{t("devices.fork.discard")}</Button>}
    </Row>
  ))}</>;
}
