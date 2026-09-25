import { inviteQrSegments } from "@ghostly/core";
import { inviteShareText } from "../lib/url";
import { QRCodeDisplay } from "./QRCode";

/**
 * The QR and the copied link are the same capability. A `ghostly1` code is shared as its link
 * (`https://ghostly.tools/#ghostly1…`) and its QR is that link in capitals; a code saved before
 * this format stays as it was. There is one kind of chat (WISP 400): nothing to choose here. A chat
 * starts on the DHT, goes live by itself, and DHT only is a choice in its Connection menu.
 */
export function InviteCard({ code }: { code: string }) {
  const shared = inviteShareText(code);
  return <div data-testid="invite-card" className="mx-auto my-3 w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-surface-alt/95 p-4 text-center">
    <h2 className="mb-3 text-sm font-medium text-text-primary">Invite your contact</h2>
    <QRCodeDisplay value={shared} qr={inviteQrSegments(code)} />
    {shared !== code && <p data-testid="invite-link" title={shared} dir="ltr" className="mt-2 truncate font-mono text-[11px] text-text-muted">{shared.replace(/^https:\/\//, "")}</p>}
  </div>;
}
