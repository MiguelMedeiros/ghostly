import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

interface QRCodeDisplayProps {
  value: string;
  label?: string;
}

export function QRCodeDisplay({ value, label }: QRCodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      {label && (
        <span className="text-text-secondary text-xs uppercase tracking-wider font-bold">
          {label}
        </span>
      )}
      <div className="bg-white p-4 rounded-xl">
        <QRCodeSVG
          value={value}
          size={200}
          bgColor="#ffffff"
          fgColor="#0b0f1a"
          level="M"
        />
      </div>
      <div className="flex items-center gap-2 w-full max-w-sm">
        <input
          type="text"
          readOnly
          value={value}
          className="flex-1 bg-surface border border-border rounded px-2 py-1.5 text-xs text-text-muted truncate font-mono"
        />
        <button
          onClick={handleCopy}
          className="px-3 py-1.5 bg-surface-hover border border-border rounded text-xs text-text-secondary hover:text-accent hover:border-accent-dim transition-colors cursor-pointer shrink-0"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
