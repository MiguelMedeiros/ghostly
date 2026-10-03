import { useI18n } from "../../contexts/I18nContext";
import type { WalletInstanceView } from "../../lib/platform";
import { WALLET_NAME } from "./names";

/** A date as people read it, in the app's language ("12 Oct 2026"). */
export function dayText(at: number, language: string): string {
  try { return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(at)); }
  catch { return new Date(at).toDateString(); }
}

/**
 * A wallet at home on another device (WISP 06 § Wallets that stay home), in place of its panel: where it can be used,
 * and for Ark and Bark when its coins expire there unless that device runs Ghostly before then.
 */
export function WalletAway({ wallet }: { wallet: Pick<WalletInstanceView, "type" | "name" | "home"> }) {
  const { t, language } = useI18n();
  if (!wallet.home) return null;
  const device = wallet.home.device || t("wallet.away.otherDevice");
  const name = wallet.type === "lightning" && wallet.name ? wallet.name : WALLET_NAME[wallet.type];
  return (
    <div data-testid="wallet-away" className="space-y-1 rounded-xl border border-border px-4 py-3 text-sm">
      <p className="font-medium text-text-primary">{t("wallet.away.title", { device })}</p>
      <p className="text-text-secondary">{t("wallet.away.text", { wallet: name, device })}</p>
      {wallet.home.expiresAt !== undefined && (
        <p data-testid="wallet-away-expires" className="text-xs text-text-muted">{t("wallet.away.expires", { date: dayText(wallet.home.expiresAt, language), device })}</p>
      )}
    </div>
  );
}
