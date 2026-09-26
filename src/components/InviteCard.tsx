import { useEffect, useRef, useState } from "react";
import { inviteQrSegments } from "@ghostly/core";
import { inviteShareText } from "../lib/url";
import { QRCodeDisplay } from "./QRCode";
import { reducedMotion } from "./wallet/motion";
import "./invite-card.css";

/** How long the card takes to leave (invite-card.css). */
export const INVITE_LEAVE_MS = 220;

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
  const shared = inviteShareText(code);
  const [mounted, setMounted] = useState(shown);
  const [leaving, setLeaving] = useState(false);
  // Only a card that left and comes back fades in: the first one is simply there, as it always was.
  const [returning, setReturning] = useState(false);
  const left = useRef(false);
  useEffect(() => {
    if (shown) {
      setLeaving(false); setMounted(true); setReturning(left.current);
      return;
    }
    left.current = true;
    if (reducedMotion()) { setMounted(false); return; }
    setLeaving(true);
    const timer = window.setTimeout(() => { setMounted(false); setLeaving(false); }, INVITE_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  if (!mounted) return null;
  return <div data-testid="invite-card" data-leaving={leaving || undefined} data-returning={(returning && !leaving) || undefined}
    aria-hidden={leaving || undefined} inert={leaving || undefined}
    className="invite-card mx-auto my-3 w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-surface-alt/95 p-4 text-center">
    <h2 className="mb-3 text-sm font-medium text-text-primary">Invite your contact</h2>
    <QRCodeDisplay value={shared} qr={inviteQrSegments(code)} />
    {shared !== code && <p data-testid="invite-link" title={shared} dir="ltr" className="mt-2 truncate font-mono text-[11px] text-text-muted">{shared.replace(/^https:\/\//, "")}</p>}
  </div>;
}
