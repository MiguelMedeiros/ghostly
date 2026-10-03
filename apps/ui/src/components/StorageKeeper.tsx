import { useEffect } from "react";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useInstallState } from "../lib/installPrompt";
import { considerPersist } from "../lib/storagePersistence";
import { sweepInterruptedRestores } from "../lib/restoreJournal";

/**
 * Asks the browser to keep this profile's data once there is something to keep (lib/storagePersistence has the
 * rules): a chat, a group or a wallet, at the start for a profile that has them and the moment the first is made.
 * Installing the app is a reason to look again. At the start, takes back what a restore stopped half way left (a tab
 * closed while it ran): never listed, it would stay on the device for good. Draws nothing.
 */
export function StorageKeeper({ hasChats }: { hasChats: boolean }) {
  const wallets = useServicesPlatform()?.wallet?.getState()?.wallets?.length ?? 0;
  const install = useInstallState();
  const hasData = hasChats || wallets > 0;
  useEffect(() => { void considerPersist(hasData); }, [hasData, install]);
  useEffect(() => { void sweepInterruptedRestores().catch(() => {}); }, []);
  return null;
}
