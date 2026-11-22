import { useI18n, type TranslationKey } from "../../contexts/I18nContext";
import type { WalletNetwork, WalletType } from "../../lib/platform";
import { fillNames } from "../../lib/fillNodes";
import { walletLabel } from "../wallet/names";

/** A wallet that stays home (WISP 06 § Wallets that stay home): its kind and network. */
export interface HomeWalletOf { type: WalletType; network: WalletNetwork }

/**
 * What a wallet loses when it leaves the database on its home device, by kind: the losses of the WISP 06 § Wallets
 * table's rows for a forced takeover or restore. Ark, Spark, the on-chain source and Lightning cards name none there.
 */
const LOSS = {
  remove: { bark: "devices.remove.home.bark", fedimint: "devices.remove.home.fedimint", usdt: "devices.remove.home.usdt" },
  here: { bark: "devices.standby.removeHere.home.bark", fedimint: "devices.standby.removeHere.home.fedimint", usdt: "devices.standby.removeHere.home.usdt" },
} satisfies Record<string, Partial<Record<WalletType, TranslationKey>>>;

/** Each wallet by its kind and network ("Mainnet Bark", "Testnet Lightning"), as the deck's headings say them. */
const nameOf = (wallet: HomeWalletOf) => walletLabel(wallet.type, wallet.network);

/**
 * The wallets at home on a device, one line each, with that kind's loss under it: on the active device, before
 * Remove <device> (`device`: what they open here instead); on that device, before Remove this profile here (no
 * `device`: what it keeps is not on the other devices).
 */
export function HomeWallets({ wallets, device, testId }: { wallets: readonly HomeWalletOf[]; device?: string; testId: string }) {
  const { t } = useI18n();
  if (!wallets.length) return null;
  const losses: Partial<Record<WalletType, TranslationKey>> = device === undefined ? LOSS.here : LOSS.remove;
  return (
    <ul data-testid={testId} className="space-y-2">
      {wallets.map((wallet, i) => {
        const name = nameOf(wallet);
        const loss = losses[wallet.type];
        return (
          <li key={`${wallet.type}:${wallet.network}:${i}`} data-testid={`${testId}-wallet`} data-type={wallet.type} className="space-y-0.5 rounded-lg bg-surface-alt px-3 py-2.5">
            <span className="block text-text-primary">
              {device === undefined ? t("devices.standby.removeHere.home.line", { wallet: name }) : fillNames(t("devices.remove.home.line", { wallet: name }), { device })}
            </span>
            {loss && <span data-testid={`${testId}-loss`} className="block text-xs text-text-muted">{t(loss)}</span>}
          </li>
        );
      })}
    </ul>
  );
}
