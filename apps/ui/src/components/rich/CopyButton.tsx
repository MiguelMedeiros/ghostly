import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { copyMessageText } from "../../lib/shareLink";

/**
 * Copies `text` and says so for a moment. A seed or a key in it is copied as a secret, as the message's own Copy does
 * (lib/shareLink.ts `copyMessageText`); a sensitive copy the platform refuses copies nothing and says so, the text
 * being right there to select by hand.
 */
export function CopyButton({ text, label, testId, className = "" }: { text: string; label?: string; testId?: string; className?: string }) {
  const { t } = useI18n();
  const [said, setSaid] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = label ?? t("chat.rich.copy");
  const say = (next: "copied" | "failed") => {
    setSaid(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), next === "copied" ? 1500 : 4000);
  };
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={said === "copied" ? t("chat.rich.copied") : said === "failed" ? t("chat.message.copyFailed") : name}
      title={said === "failed" ? t("chat.message.copyFailed") : undefined}
      onClick={() => { void copyMessageText(text).then(() => say("copied"), () => say("failed")); }}
      className={`rich-action ${className}`}
    >
      {said === "copied" ? t("chat.rich.copied") : said === "failed" ? t("chat.rich.notCopied") : t("chat.rich.copy")}
    </button>
  );
}
