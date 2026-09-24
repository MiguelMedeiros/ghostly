import { useEffect, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { qrText } from "@ghostly/core";
import { useServicesPlatform } from "../hooks/useServicesPlatform";

/**
 * Paying, or being paid, with a wallet that is not Ghostly: the invoice or address as a QR code, as text
 * to copy, and as a `lightning:` / `bitcoin:` link a wallet on this device opens. Settlement is never
 * assumed from any of it: the payee's own wallet decides, and "I paid" only asks it to look now.
 *
 * `testId` names the text element; the QR, the copy button, the link and the "I paid" button carry it
 * with a suffix (`-qr`, `-copy`, `-link`, `-paid`).
 */
export function PayExternally({ uri, value, testId, note, onPaid, size = 144, actions }: {
  /** What a wallet opens: `lightning:…`, `bitcoin:…`. */
  uri: string;
  /** What is copied: the bare invoice or address. */
  value: string;
  testId: string;
  note?: ReactNode;
  /** "I paid": asks the payee's app to look now. Left out on the receiving side. */
  onPaid?: () => Promise<void>;
  size?: number;
  /** More buttons beside Copy. */
  actions?: ReactNode;
}) {
  const platform = useServicesPlatform();
  const [copied, setCopied] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy. Select the text and copy it yourself.");
    }
  };
  const button = "px-3 py-1.5 min-h-9 max-md:min-h-11 rounded-lg text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex flex-wrap gap-3 items-start justify-center" data-testid={`${testId}-external`}>
      <div className="bg-white rounded-xl p-2.5 shrink-0" data-testid={`${testId}-qr`}>
        <QRCodeSVG value={qrText(uri)} size={size} title="Payment QR code" bgColor="#ffffff" fgColor="#0b0f1a" level="L" className="block max-w-full h-auto" />
      </div>
      <div className="min-w-0 flex-[1_1_12rem] space-y-2">
        <code className="block break-all select-all bg-black/20 rounded-lg p-2 text-[10px] text-inherit opacity-80 font-mono max-h-20 overflow-y-auto" data-testid={testId}>{value}</code>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={`${button} bg-accent text-[#111b21] hover:bg-accent-hover`} data-testid={`${testId}-copy`} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          <a
            className={`${button} bg-black/20 hover:bg-black/30 no-underline text-inherit inline-flex items-center`}
            href={uri}
            data-testid={`${testId}-link`}
            title="Open in a wallet on this device"
            onClick={(event) => {
              // The desktop app and the extension hand the link to the system; a web page lets the browser.
              const opened = platform?.openPaymentLink(uri);
              if (!opened) return;
              event.preventDefault();
              setError("");
              opened.catch((cause: unknown) => setError(`Could not open a wallet: ${cause instanceof Error ? cause.message : String(cause)}. Copy the text or scan the code instead.`));
            }}
          >
            Open wallet
          </a>
          {actions}
          {onPaid && (
            <button type="button" className={`${button} bg-black/20 hover:bg-black/30`} data-testid={`${testId}-paid`} disabled={busy} title="Your contact's wallet is asked to look now. It marks the request paid only once it sees the money." onClick={() => {
              setBusy(true); setError("");
              onPaid().then(() => setChecked(true), (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
            }}>
              {busy ? "Asking…" : checked ? "Checking…" : "I paid"}
            </button>
          )}
        </div>
        {checked && <p className="text-[11px] m-0 opacity-70" data-testid={`${testId}-checking`}>Your contact's wallet is being checked. It turns Paid here by itself once the payment is seen.</p>}
        {note && <p className="text-[11px] m-0 opacity-70">{note}</p>}
        {error && <p className="text-[11px] m-0 text-danger" role="alert">{error}</p>}
      </div>
    </div>
  );
}
