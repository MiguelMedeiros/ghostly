import { useEffect, useRef, useState } from "react";
import { inviteQrSegments } from "@ghostly/core";
import { inviteShareText } from "../lib/url";
import { QRCodeDisplay } from "./QRCode";
import { reducedMotion } from "./wallet/motion";
import { MESSAGE_LIST } from "./MessageBubble";
import { focusInPlace } from "../lib/focus";
import { touchOnly } from "../lib/touchOnly";
import { useI18n } from "../contexts/I18nContext";
import "./invite-card.css";

/** How long the card takes to leave (invite-card.css). */
export const INVITE_LEAVE_MS = 220;

/**
 * The contact arrived while the focus was in the card (its Copy, its Share): the card goes out of reach at once, which
 * would leave the focus on the page, the next Tab starting from its top. It goes to the chat's message field, live now;
 * on a touch screen (the keyboard would come up) or where the field takes no text, to the messages. A focus elsewhere stays.
 */
function handFocusOn(card: HTMLElement | null) {
  if (!card?.contains(document.activeElement)) return;
  const list = card.closest<HTMLElement>(MESSAGE_LIST);
  let column = list?.parentElement;
  while (column && !column.querySelector("[data-composer]")) column = column.parentElement;
  const field = touchOnly() ? null : column?.querySelector<HTMLTextAreaElement>("[data-composer] textarea:not(:disabled)");
  if (field) { focusInPlace(field); return; }
  if (!list) return;
  if (!list.hasAttribute("tabindex")) {
    list.tabIndex = -1;
    list.addEventListener("blur", () => list.removeAttribute("tabindex"), { once: true });
  }
  list.focus({ preventScroll: true });
}

/**
 * The QR and the copied link are the same capability. A `ghostly1` code is shared as its link
 * (`https://ghostly.tools/#ghostly1…`) and its QR is that link in capitals; a code saved before
 * this format stays as it was. There is one kind of chat (WISP 400): nothing to choose here. A chat
 * starts on the DHT, goes live by itself, and DHT only is a choice in its Connection menu.
 *
 * `shown` false takes the card away: it fades out (at once with reduced motion), and fades back in if it
 * is shown again.
 */
export function InviteCard({ code, shown = true }: { code: string; shown?: boolean }) {
  const { t } = useI18n();
  const shared = inviteShareText(code);
  const [mounted, setMounted] = useState(shown);
  const [leaving, setLeaving] = useState(false);
  // Only a card that left and comes back fades in: the first one is simply there, as it always was.
  const [returning, setReturning] = useState(false);
  const left = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) {
      setLeaving(false); setMounted(true); setReturning(left.current);
      return;
    }
    left.current = true;
    handFocusOn(cardRef.current);
    if (reducedMotion()) { setMounted(false); return; }
    setLeaving(true);
    const timer = window.setTimeout(() => { setMounted(false); setLeaving(false); }, INVITE_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  if (!mounted) return null;
  return <div ref={cardRef} data-testid="invite-card" data-leaving={leaving || undefined} data-returning={(returning && !leaving) || undefined}
    aria-hidden={leaving || undefined} inert={leaving || undefined}
    className="invite-card mx-auto my-3 w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-surface-alt/95 p-4 text-center">
    <h2 className="mb-3 text-sm font-medium text-text-primary">{t("invite.title")}</h2>
    <QRCodeDisplay value={shared} qr={inviteQrSegments(code)} />
    {shared !== code && <p data-testid="invite-link" title={shared} dir="ltr" className="mt-2 truncate font-mono text-[11px] text-text-muted">{shared.replace(/^https:\/\//, "")}</p>}
  </div>;
}
