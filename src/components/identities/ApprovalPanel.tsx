import { QRCodeSVG } from "qrcode.react";
import type { ApprovalRequest } from "@ghostly/browser/proofs/contract";
import { Button } from "../wallet/ui";

/**
 * A request waiting for the person's approval elsewhere, both ways on one screen (Pubky: a big button that opens
 * Pubky Passport, and a QR code of the same request for Pubky Ring). Whichever approves first wins; the signer then
 * takes this screen away. The button calls `open.run()` straight from its click: a popup opened later, after an
 * await, would be blocked. The QR's value is a secret: it is drawn, never copied, logged or put in a link.
 */
export function ApprovalPanel({ request, onCancel }: { request: ApprovalRequest; onCancel?: () => void }) {
  return (
    <div data-testid="approval" className="space-y-4">
      {request.open && (
        <div className="space-y-1.5">
          <Button variant="primary" data-testid="approval-open" className="w-full min-h-12 !whitespace-normal" onClick={() => request.open!.run()}>{request.open.label}</Button>
          {request.open.description && <p className="text-xs text-text-muted">{request.open.description}</p>}
        </div>
      )}
      {request.open && request.qr && <div aria-hidden="true" className="h-px bg-border" />}
      {request.qr && (
        <figure data-testid="approval-qr" className="space-y-2">
          <div className="mx-auto w-fit rounded-xl bg-white p-3">
            <QRCodeSVG value={request.qr.value} size={208} level="M" role="img" aria-label={request.qr.label} />
          </div>
          <figcaption className="text-center text-sm text-text-primary">{request.qr.label}</figcaption>
        </figure>
      )}
      {request.notes?.map(note => <p key={note} className="text-xs text-text-muted">{note}</p>)}
      {onCancel && (
        <div className="flex justify-end">
          <Button data-testid="approval-cancel" onClick={onCancel}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
