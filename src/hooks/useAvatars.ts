import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";

const subscribe = (listener: () => void) => engine.subscribe(listener);

/** This profile's picture (WISP 04), kept by the peer and sent to paired contacts. */
export function useMyAvatar(): string | undefined {
  return useSyncExternalStore(subscribe, () => engine.state?.settings.avatar);
}

/** The picture a contact sent in this chat, if any. */
export function usePeerAvatar(peerPubKey?: string): string | undefined {
  return useSyncExternalStore(subscribe, () => (peerPubKey ? engine.linkByPeer(peerPubKey)?.peerAvatar : undefined));
}

/** `null` removes it; contacts connected right now are told at once, the others on their next session. */
export function setMyAvatar(avatar: string | null): Promise<void> {
  return engine.call("updateSettings", { settings: { avatar: avatar ?? "" } });
}

/** Real money or test networks: which wallets are in use, for the warning shown everywhere in Testnet. */
export function useWalletMode(): "mainnet" | "testnet" {
  return useSyncExternalStore(subscribe, () => engine.state?.wallet?.mode ?? "mainnet");
}
