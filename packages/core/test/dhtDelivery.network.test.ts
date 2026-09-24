import { expect, it, vi } from "vitest";
import { DhtDelivery, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { RelayTransport } from "../src/relay";
import type { PairingCredentials } from "../src/pairedSession";
// covers-gated: chat.dht.delivery, chat.dht.offline, core.relay-client

it.skipIf(process.env.TEST_DHT_NETWORK !== "1")("publishes an encrypted disposable text through public relays, late receiver and signed receipt", async () => {
  const invitation = createLink();
  const states = [emptyDhtDeliveryState(), emptyDhtDeliveryState()];
  const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
  const messages = [vi.fn(), vi.fn()], receipts = [vi.fn(), vi.fn()];
  const make = (i: number) => new DhtDelivery({ params: i ? invitation.invite : invitation.mine, mode: "dht", credentials: credentials[i], state: states[i],
    transport: new RelayTransport({ timeoutMs: 8_000 }), pollMs: 5_000,
    save: async (state: DhtDeliveryState) => { states[i] = state; }, pin: async key => { credentials[i].peerKey = key; },
    message: async m => { messages[i](m); }, receipt: async id => { receipts[i](id); }, changed: () => {},
  });
  let a = make(0); const b = make(1);
  try {
    await a.start();
    expect(await a.send("Disposable Ghostly DHT integration test", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
    await a.stop();
    await b.start();
    await vi.waitFor(() => expect(messages[1]).toHaveBeenCalledWith(expect.objectContaining({ text: "Disposable Ghostly DHT integration test" })), { timeout: 40_000, interval: 1000 });
    a = make(0); await a.start();
    await vi.waitFor(() => expect(receipts[0]).toHaveBeenCalledWith("abcdefghijklmnopqrstuv"), { timeout: 40_000, interval: 1000 });
    expect(states[0].pending).toBeUndefined();
  } finally { await a.stop(); await b.stop(); }
}, 110_000);
