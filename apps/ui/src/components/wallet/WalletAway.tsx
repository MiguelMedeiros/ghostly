import { useI18n } from "../../contexts/I18nContext";
import type { WalletInstanceView, WalletPlatform } from "../../lib/platform";
import { WALLET_NAME } from "./names";
import { dayText } from "../../lib/handoff";
import { BackupRows } from "./BackupRows";
import { useRun } from "./run";
import { exportBackup, reveal } from "./walletPhrase";
import { Notice } from "./ui";

/** The kinds whose phrase or backup file reaches the funds from any device. */
const PHRASE = new Set(["arkade", "bark", "spark", "usdt", "fedimint"]);

/**
 * A wallet at home on another device (WISP 06 § Wallets that stay home), in place of its panel: where it can be used,
 * for Ark and Bark when its coins expire there unless that device runs Ghostly before then, and its recovery phrase and
 * backup file (read here, the wallet itself never opened): if that device is lost, the funds are reachable from them.
 */
export function WalletAway({ wallet, platform }: { wallet: Pick<WalletInstanceView, "type" | "name" | "home">; platform?: WalletPlatform }) {
  const { t, language } = useI18n();
  const backup = useRun();
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
      {platform && PHRASE.has(wallet.type) && <>
        <p className="text-xs text-text-muted" data-testid="wallet-away-backup">{t("wallet.away.backup", { device })}</p>
        <BackupRows name={WALLET_NAME[wallet.type]} busy={backup.busy} run={backup.run} reveal={() => reveal(platform, wallet.type)} exportBackup={(password) => exportBackup(platform, wallet.type, password)} />
        {backup.error && <Notice problem={backup.error} />}
      </>}
    </div>
  );
}
