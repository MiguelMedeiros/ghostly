import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";

/** Copies `text` and says so for a moment. */
export function CopyButton({ text, label, testId, className = "" }: { text: string; label?: string; testId?: string; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = label ?? t("chat.rich.copy");
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={copied ? t("chat.rich.copied") : name}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }, () => {});
      }}
      className={`rich-action ${className}`}
    >
      {copied ? t("chat.rich.copied") : t("chat.rich.copy")}
    </button>
  );
}
