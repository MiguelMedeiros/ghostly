import type { PostedEvent } from "../shared/rpc";
import type { EngineState } from "../shared/types";
import type { EngineClientSink } from "./server";

/**
 * A client whose messages are copied on their way (the extension's port): every state used to carry every payment
 * this device kept and the whole wallet, copied each time, up to 20 times a second. `payments` and `wallet` are the
 * same objects until one changes (`PaymentBook`, `walletView`): a state whose own are the ones this client was sent
 * last leaves them out, and the page keeps those (`PostedState`). The first state always carries them.
 */
export function copyingSink(post: (message: PostedEvent) => void): EngineClientSink {
  let sent: Pick<EngineState, "payments" | "wallet"> | null = null;
  return {
    post: (message) => {
      if (message.kind !== "state") return post(message);
      const { payments, wallet, ...rest } = message.state;
      post({ kind: "state", state: { ...rest, ...(sent && payments === sent.payments ? {} : { payments }), ...(sent && wallet === sent.wallet ? {} : { wallet }) } });
      sent = { payments, wallet };
    },
  };
}
