import type { WalletNetwork } from "@ghostly/core";
import type { WalletMode } from "../../shared/mints";

/** A wallet of the mode being left stopped opening: the switch goes ahead without waiting for its network. */
export class ModeChanged extends Error {
  constructor() { super("The wallets switched mode"); this.name = "ModeChanged"; }
}

export const networkLabel = (network: WalletNetwork) => network === "mainnet" ? "Mainnet" : "Testnet";

/**
 * What was asked of one network's wallet belongs to the other network's (a backup, a chain): nothing was changed.
 * `network` is where it belongs, so the engine can hand it to that wallet instead.
 */
export class WrongNetworkError extends Error {
  constructor(readonly network: WalletNetwork, message: string) { super(message); this.name = "WrongNetworkError"; }
}

/**
 * Opening a wallet waits on its network (an Ark server, an RPC), which can take minutes or never answer.
 * A mode switch must not wait behind that: `within` gives up on the wait as soon as the mode changes, and
 * whatever still arrives afterwards is handed to `dispose`. Nothing is saved before that wait ends, so
 * giving up leaves the profile as it was. Every wait on the network inside a wallet's queue goes through it,
 * reading a balance too, or the switch, queued behind it, waits anyway.
 */
export class ModeGate {
  constructor(private target: WalletMode = "mainnet") {}
  private controller = new AbortController();
  /** The mode its owner works in, once it says so: a wait that starts while a switch away from it is queued ends at once. */
  private current?: WalletMode;

  /** A switch to `mode` was asked for: waits for a wallet of another mode end now. */
  switching(mode: WalletMode) {
    if (this.target === mode) return;
    this.target = mode;
    this.controller.abort();
    this.controller = new AbortController();
  }

  /** The owner's switch to `mode` is applied (its queue reached it): waits are for this mode again. */
  entered(mode: WalletMode) { this.current = mode; }

  /**
   * A creation took too long: the waits under way end now, and so does every wait that starts until `resume`
   * (a creation still sealing its seed has not reached its server yet, and must not wait there either).
   */
  interrupt() { this.cut = true; this.controller.abort(); this.controller = new AbortController(); }
  resume() { this.cut = false; }
  private cut = false;

  /** The wallet stopped: every wait ends now, and any later one at once. */
  close() { this.closed = true; this.controller.abort(); }
  private closed = false;

  within<T>(work: Promise<T>, dispose?: (value: T) => unknown): Promise<T> {
    const signal = this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      const give = () => { reject(new ModeChanged()); void work.then((value) => dispose?.(value), () => {}); };
      if (this.closed || this.cut || (this.current && this.current !== this.target)) return give();
      signal.addEventListener("abort", give, { once: true });
      work.then(
        (value) => { signal.removeEventListener("abort", give); if (!signal.aborted) resolve(value); },
        (error) => { signal.removeEventListener("abort", give); if (!signal.aborted) reject(error); },
      );
    });
  }
}
