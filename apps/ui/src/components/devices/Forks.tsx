import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { Row } from "../layout";
import { Button } from "../wallet/ui";
import { type Problem, problemText } from "../../lib/problemText";
import { formatAt } from "../../lib/time";
import type { Translate } from "../../locales/translate";
import { Notice } from "../ui/Notice";

/** How long the question's Discard stays off after it shows: longer than a double click or a key pressed twice. */
const CONFIRM_SETTLE_MS = 500;

/**
 * What tells each fork apart, in the list's order (the order they were kept): when it was kept, in the app's language,
 * or "Older copy" for one an older build kept without a time (numbered when there are several). Never the same words
 * on two rows: two kept in the same minute are numbered after their time.
 */
function forkNames(forks: readonly string[], keptAt: Readonly<Record<string, number>> | undefined, t: Translate): string[] {
  const undated = forks.filter((fork) => keptAt?.[fork] === undefined).length;
  let older = 0;
  const names = forks.map((fork) => {
    const at = keptAt?.[fork];
    if (at !== undefined) return t("devices.fork.kept", { when: formatAt(at, { dateStyle: "medium", timeStyle: "short" }, t.language) });
    older++;
    return undated > 1 ? t("devices.fork.olderNumbered", { n: older }) : t("devices.fork.older");
  });
  return names.map((name, i) => (names.indexOf(name) === names.lastIndexOf(name) ? name
    : t("devices.fork.repeat", { which: name, n: names.slice(0, i + 1).filter((other) => other === name).length })));
}

/**
 * "Only on this device" in Data and storage (WISP 06 § Installing the staged state): the copies of this profile a
 * replaced device kept each time it took the profile back with Use here. What is in one never reached the profile;
 * Discard removes it for good, after a second press. Each row says when its copy was kept, and so does its Discard's
 * name. `forks`, `keptAt`: the device set's view of them (`DeviceSetView.forks`, `forkKeptAt`), as the page read it.
 */
export function ForkRows({ forks, keptAt }: { forks?: readonly string[]; keptAt?: Readonly<Record<string, number>> }) {
  const { t } = useI18n();
  const [gone, setGone] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The question's Discard works only a moment after it shows: the second press of a double click (or a second Enter)
  // is not an answer. The focus goes to Cancel, and back to the row's Discard after Cancel.
  const [armed, setArmed] = useState(false);
  const [cancelled, setCancelled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  // A copy discarded: its row goes with the focused button. The focus goes to the next copy's Discard (the one before
  // when it was the last row), else to the section's title, never to the page.
  const discardButtons = useRef(new Map<string, HTMLButtonElement>());
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [focusAfter, setFocusAfter] = useState<{ next: string } | { section: Element } | null>(null);
  useEffect(() => {
    setArmed(false);
    if (confirming === null) return;
    const timer = setTimeout(() => setArmed(true), CONFIRM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  useEffect(() => {
    if (!focusAfter) return;
    setFocusAfter(null);
    if ("next" in focusAfter) { discardButtons.current.get(focusAfter.next)?.focus(); return; }
    const title = focusAfter.section.querySelector<HTMLElement>("h2") ?? (focusAfter.section as HTMLElement);
    if (!title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1");
    title.focus();
  }, [focusAfter]);
  const shown = (forks ?? []).filter((database) => !gone.includes(database));
  const names = forkNames(shown, keptAt, t);
  const discard = (database: string) => {
    setBusy(true); setError(null);
    void engine.call("deviceForkDiscard", { database })
      .then(() => {
        const at = shown.indexOf(database);
        const next = shown[at + 1] ?? shown[at - 1];
        const section = confirmButton.current?.closest("section");
        setConfirming(null); setGone((was) => [...was, database]);
        setFocusAfter(next !== undefined ? { next } : section ? { section } : null);
      }, (e: unknown) => setError(problemText(e, t)))
      .finally(() => setBusy(false));
  };
  const keepButton = (database: string) => (button: HTMLButtonElement | null) => {
    if (button) discardButtons.current.set(database, button); else discardButtons.current.delete(database);
  };
  return <>{shown.map((database, i) => {
    const which = names[i];
    const named = t("devices.fork.discardWhich", { which });
    return (
      <Row key={database} testId="settings-fork" label={t("devices.fork.title")} value={<span data-testid="settings-fork-kept">{which}</span>}
        hint={error && confirming === database ? <Notice problem={error} className="text-xs" /> : confirming === database ? t("devices.fork.confirm") : t("devices.fork.hint")} info={t("devices.fork.info")}>
        {confirming === database ? <>
          <Button key="confirm" ref={confirmButton} variant="danger" data-testid="settings-fork-discard-confirm" aria-label={named} disabled={busy || !armed} onClick={() => discard(database)}>{t("devices.fork.discard")}</Button>
          <Button key="cancel" data-testid="settings-fork-cancel" autoFocus disabled={busy} onClick={() => { setCancelled(database); setConfirming(null); }}>{t("common.cancel")}</Button>
        </> : <Button key="discard" ref={keepButton(database)} variant="danger" data-testid="settings-fork-discard" aria-label={named} autoFocus={cancelled === database}
          onClick={() => { setError(null); setCancelled(null); setConfirming(database); }}>{t("devices.fork.discard")}</Button>}
      </Row>
    );
  })}</>;
}
