import { useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useEngineValue } from "../../lib/engineState";
import { focusLost } from "../../lib/focus";
import { isolate } from "../../lib/ownStatus";
import { publicKeyLabel } from "../../lib/publicKeyLabel";
import { Row, Section } from "../layout";
import { Button } from "../wallet/ui";

/**
 * Settings → Privacy, **Blocked contacts**: each contact blocked here (a chat's ⋮ → Block contact), named as its chat
 * is (its key's short form once no chat with it is left), with Unblock. The list is the profile's settings, so it is
 * the same on the person's other devices.
 */
export function BlockedContacts() {
  const { t } = useI18n();
  const lines = useEngineValue((state) => (state?.settings.blockedContacts ?? []).map((key) => {
    const chat = state?.links.find((link) => link.peerPubKeyZ32 === key);
    return { key, name: chat?.label?.trim() || chat?.peerNick?.trim() || publicKeyLabel(key) };
  }));
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const unblock = async (key: string, i: number) => {
    setUnblocking(key);
    try {
      await engine.call("setContactBlocked", { peerPubKeyZ32: key, blocked: false });
    } catch { /* still listed: the button stays for another try */ }
    setUnblocking(null);
    // The row goes: the focus moves to the next one (or the one before), not to the page.
    if (focusLost()) (buttons.current[i + 1] ?? buttons.current[i - 1])?.focus();
  };

  return (
    <Section title={t("settings.blocked.title")}>
      {lines.length === 0
        ? <Row label={t("settings.blocked.none")} hint={t("settings.blocked.hint")} testId="settings-blocked-none" />
        : lines.map((line, i) => (
          <Row key={line.key} label={line.name} testId="settings-blocked-contact">
            <Button ref={(button) => { buttons.current[i] = button; }} loading={unblocking === line.key} disabled={unblocking !== null}
              aria-label={t("settings.blocked.unblockLabel", { name: isolate(line.name) })} onClick={() => void unblock(line.key, i)}>
              {t("settings.blocked.unblock")}
            </Button>
          </Row>
        ))}
    </Section>
  );
}
