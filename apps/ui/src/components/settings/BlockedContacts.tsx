import { Fragment, useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import { useEngineValue } from "../../lib/engineState";
import { focusLost } from "../../lib/focus";
import { contactName, usePeerChats } from "../../lib/identities";
import { isolate } from "../../lib/ownStatus";
import { problemLine, problemText } from "../../lib/problemText";
import { contactTag } from "../../lib/publicKeyLabel";
import { Row, Section } from "../layout";
import { Button, Notice } from "../wallet/ui";

/**
 * Settings → Privacy, **Blocked contacts**: each contact blocked here (a chat's ⋮ → Block contact), named as the chat
 * list names its chat ("Contact · <tag>" when it has no name, or no chat is left), with Unblock. The list is the
 * profile's settings, so it is the same on the person's other devices.
 */
export function BlockedContacts() {
  const { t } = useI18n();
  const blocked = useEngineValue((state) => (state?.settings.blockedContacts ?? []).map((key) => {
    const chat = state?.links.find((link) => link.peerPubKeyZ32 === key);
    return { key, name: chat?.label?.trim() || chat?.peerNick?.trim() || "" };
  }));
  // A name given in the chat's header is kept in the page's stored chat, not in the engine's link: read as the chat
  // list reads it, and again when it changes (`usePeerChats`). The link's names stay for a chat only the engine has.
  const chats = usePeerChats(blocked.length > 0, blocked);
  // Unnamed, as the chat list says it: "Contact · <tag>". A name the chat or the contact chose is drawn in its own <bdi>,
  // as Devices draws a device's: "Ana (2)" in an Arabic page otherwise reads ")Ana (2". The fallback is the app's words.
  const lines = blocked.map((line) => {
    const own = contactName(chats.get(line.key))?.trim() || line.name;
    const name = own || t("common.unnamedContact", { key: contactTag(line.key) });
    return { ...line, name, shown: own ? <bdi>{own}</bdi> : name };
  });
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; why: string; detail?: string } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const none = useRef<HTMLDivElement>(null);
  const handOff = useRef<{ gone: string; next?: string } | null>(null);
  // The row goes: the focus moves to the next one (or the one before), not to the page, once that row's button is drawn
  // enabled again and the unblocked row is gone (whichever comes last: the engine's state or its answer). The last one
  // gone: to the line that says none is left.
  useEffect(() => {
    const hand = handOff.current;
    if (!hand || unblocking !== null || lines.some((line) => line.key === hand.gone)) return;
    handOff.current = null;
    if (focusLost()) (hand.next ? buttons.current.get(hand.next) : none.current)?.focus();
  });

  const unblock = async (key: string, i: number) => {
    setUnblocking(key);
    setFailed(null);
    handOff.current = { gone: key, next: lines[i + 1]?.key ?? lines[i - 1]?.key };
    try {
      await engine.call("setContactBlocked", { peerPubKeyZ32: key, blocked: false });
    } catch (e) {
      // Still listed: the button stays for another try, and the line under the row says why (a device with no room left).
      handOff.current = null;
      setFailed({ key, why: problemLine(e, t), detail: problemText(e, t).detail });
    }
    setUnblocking(null);
  };

  return (
    <Section title={t("settings.blocked.title")}>
      {lines.length === 0
        ? <div ref={none} tabIndex={-1} className="focus:outline-none">
            <Row label={t("settings.blocked.none")} hint={t("settings.blocked.hint")} testId="settings-blocked-none" />
          </div>
        : lines.map((line, i) => (
          <Fragment key={line.key}>
            <Row label={line.shown} testId="settings-blocked-contact">
              <Button ref={(button) => { if (button) buttons.current.set(line.key, button); else buttons.current.delete(line.key); }} loading={unblocking === line.key} disabled={unblocking !== null}
                aria-label={t("settings.blocked.unblockLabel", { name: isolate(line.name) })} onClick={() => void unblock(line.key, i)}>
                {t("settings.blocked.unblock")}
              </Button>
            </Row>
            {failed?.key === line.key && <div className="px-4 py-3">
              <Notice tone="error" title={t("chat.block.unblockFailed")} next={failed.why} details={failed.detail} testId="settings-blocked-error" />
            </div>}
          </Fragment>
        ))}
    </Section>
  );
}
