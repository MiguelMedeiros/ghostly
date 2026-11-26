import { useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useEngineValue } from "../../lib/engineState";
import { focusLost } from "../../lib/focus";
import { isolate } from "../../lib/ownStatus";
import { contactTag } from "../../lib/publicKeyLabel";
import { Row, Section } from "../layout";
import { Button } from "../wallet/ui";

/**
 * Settings → Privacy, **Blocked contacts**: each contact blocked here (a chat's ⋮ → Block contact), named as its chat
 * is ("Contact · <tag>" when it has no name, or no chat is left), with Unblock. The list is the profile's settings, so it is
 * the same on the person's other devices.
 */
export function BlockedContacts() {
  const { t } = useI18n();
  const blocked = useEngineValue((state) => (state?.settings.blockedContacts ?? []).map((key) => {
    const chat = state?.links.find((link) => link.peerPubKeyZ32 === key);
    return { key, name: chat?.label?.trim() || chat?.peerNick?.trim() || "" };
  }));
  // Unnamed, as the chat list says it: "Contact · <tag>".
  const lines = blocked.map((line) => ({ ...line, name: line.name || t("common.unnamedContact", { key: contactTag(line.key) }) }));
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const handOff = useRef<{ gone: string; next?: string } | null>(null);
  // The row goes: the focus moves to the next one (or the one before), not to the page, once that row's button is drawn
  // enabled again and the unblocked row is gone (whichever comes last: the engine's state or its answer).
  useEffect(() => {
    const hand = handOff.current;
    if (!hand || unblocking !== null || lines.some((line) => line.key === hand.gone)) return;
    handOff.current = null;
    if (focusLost() && hand.next) buttons.current.get(hand.next)?.focus();
  });

  const unblock = async (key: string, i: number) => {
    setUnblocking(key);
    handOff.current = { gone: key, next: lines[i + 1]?.key ?? lines[i - 1]?.key };
    try {
      await engine.call("setContactBlocked", { peerPubKeyZ32: key, blocked: false });
    } catch { handOff.current = null; /* still listed: the button stays for another try */ }
    setUnblocking(null);
  };

  return (
    <Section title={t("settings.blocked.title")}>
      {lines.length === 0
        ? <Row label={t("settings.blocked.none")} hint={t("settings.blocked.hint")} testId="settings-blocked-none" />
        : lines.map((line, i) => (
          <Row key={line.key} label={line.name} testId="settings-blocked-contact">
            <Button ref={(button) => { if (button) buttons.current.set(line.key, button); else buttons.current.delete(line.key); }} loading={unblocking === line.key} disabled={unblocking !== null}
              aria-label={t("settings.blocked.unblockLabel", { name: isolate(line.name) })} onClick={() => void unblock(line.key, i)}>
              {t("settings.blocked.unblock")}
            </Button>
          </Row>
        ))}
    </Section>
  );
}
