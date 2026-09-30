import type { WalletPlatform, WalletType } from "../../lib/platform";

/** The recovery phrase of a wallet that has one: shown only on Show, never kept anywhere but on screen. */
export async function reveal(wallet: WalletPlatform, type: WalletType): Promise<string> {
  switch (type) {
    case "arkade": return (await wallet.arkBackup()).mnemonic;
    case "bark": return (await wallet.barkBackup()).mnemonic;
    case "spark": return (await wallet.sparkBackup()).mnemonic;
    case "usdt": return wallet.usdtReveal();
    case "fedimint": return (await wallet.fedimintBackup()).mnemonic;
    default: throw new Error("This wallet has no recovery phrase to show");
  }
}
/** The wallet's own encrypted backup file. */
export function exportBackup(wallet: WalletPlatform, type: WalletType, password: string): Promise<string> {
  switch (type) {
    case "arkade": return wallet.arkExportBackup(password);
    case "bark": return wallet.barkExportBackup(password);
    case "spark": return wallet.sparkExportBackup(password);
    case "usdt": return wallet.usdtExportBackup(password);
    case "fedimint": return wallet.fedimintExportBackup(password);
    default: return Promise.reject(new Error("This wallet has no backup file"));
  }
}
