import type { WalletMode } from "../../shared/mints";

/** A wallet of the mode being left stopped opening: the switch goes ahead without waiting for its network. */
export class ModeChanged extends Error {
  constructor() { super("The wallets switched mode"); this.name = "ModeChanged"; }
}

/**
 * Opening a wallet waits on its network (an Ark server, an RPC), which can take minutes or never answer.
 * A mode switch must not wait behind that: `within` gives up on the wait as soon as the mode changes, and
 * whatever still arrives afterwards is handed to `dispose`. Nothing is saved before that wait ends, so
 * giving up leaves the profile as it was.
 */
export class ModeGate {
  constructor(private target: WalletMode = "mainnet") {}
  private controller = new AbortController();

  /** A switch to `mode` was asked for: waits for a wallet of another mode end now. */
  switching(mode: WalletMode) {
    if (this.target === mode) return;
    this.target = mode;
    this.controller.abort();
    this.controller = new AbortController();
  }

  within<T>(work: Promise<T>, dispose?: (value: T) => unknown): Promise<T> {
    const signal = this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      const give = () => { reject(new ModeChanged()); void work.then((value) => dispose?.(value), () => {}); };
      signal.addEventListener("abort", give, { once: true });
      work.then(
        (value) => { signal.removeEventListener("abort", give); if (!signal.aborted) resolve(value); },
        (error) => { signal.removeEventListener("abort", give); if (!signal.aborted) reject(error); },
      );
    });
  }
}
