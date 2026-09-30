import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../contexts/I18nContext";

interface QRCodeDisplayProps {
  /** What Copy and Share hand over. */
  value: string;
  /** What the QR encodes, when not `value`: segments, each in the mode that fits it (an invite link in capitals). */
  qr?: string[];
  label?: string;
}

export function QRCodeDisplay({ value, qr, label }: QRCodeDisplayProps) {
  const { t } = useI18n();
  const currentValue = useRef(value); currentValue.current = value;
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    setError(""); setCopied(false); clearTimeout(copiedTimer.current);
    try {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const previous = document.activeElement as HTMLElement | null;
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed"; textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("Copy unavailable");
        } finally {
          textarea.remove();
          if (previous?.isConnected) previous.focus();
        }
      }
      if (currentValue.current !== value) return;
      setCopied(true);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (currentValue.current === value) setError(t("invite.copyFailed"));
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      {label && (
        <span className="text-text-secondary text-xs uppercase tracking-wider font-bold">
          {label}
        </span>
      )}
      <div data-testid="invite-qr" className="bg-white p-4 rounded-xl max-w-full [&_svg]:max-w-full [&_svg]:h-auto">
        <QRCodeSVG
          value={qr ?? value}
          size={232}
          marginSize={2}
          title="Invite QR code"
          bgColor="#ffffff"
          fgColor="#0b0f1a"
          level="M"
        />
      </div>
      <button onClick={() => void handleCopy()} aria-label={copied ? t("common.copied") : t("invite.copy")}
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-panel-header cursor-pointer hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-alt">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
          <rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>
        </svg>
        <span role="status">{copied ? t("common.copied") : t("invite.copy")}</span>
      </button>
      {typeof navigator.share === "function" && <button onClick={() => {
        setError("");
        void navigator.share({text: value}).catch((cause: unknown) => {
          if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(t("invite.shareFailed"));
        });
      }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-xs text-text-muted cursor-pointer hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>
        {t("tabs.share")}
      </button>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  );
}
