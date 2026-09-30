import { backupDue, type BackupDue } from "@ghostly/browser/shared/backupReminder";
import { useServicesPlatform } from "./useServicesPlatform";

/**
 * The Mainnet wallets whose backup reminder asks now (shared/backupReminder): real money came in and no copy was
 * made yet, and no "Later" holds it off. The Wallet page shows the first; the wallet icon wears a dot while any asks.
 */
export function useBackupDue(): BackupDue[] {
  const state = useServicesPlatform()?.wallet?.getState();
  return backupDue(state?.backupReminders, state?.wallets, Date.now());
}
