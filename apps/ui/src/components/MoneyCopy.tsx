import { useI18n } from "../contexts/I18nContext";
import { Notice } from "./ui/Notice";

/**
 * A refused copy of money in a message (hooks/useMoneyCopy.ts), said on its card, with the text itself to select and
 * copy by hand: an invoice's or a token's card shows only its QR code.
 */
export function MoneyCopyRefused({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <div className="basis-full min-w-0 space-y-1">
      <Notice tone="error" testId="money-copy-error" className="text-xs m-0" ink>{t("payments.external.copyError")}</Notice>
      <code tabIndex={0} dir="ltr" className="block break-all select-all bg-black/20 rounded-lg p-2 text-[10px] text-inherit opacity-80 font-mono max-h-20 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="money-copy-text">{value}</code>
    </div>
  );
}
