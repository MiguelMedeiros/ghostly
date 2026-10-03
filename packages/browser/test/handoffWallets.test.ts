import { describe, expect, it } from "vitest";
import { walletHandoffProblem } from "../src/devices/handoffWallets";
import type { WalletView } from "../src/shared/types";
// covers: devices.handoff.machine

/*
 * Until wallets move (WISP 06, part 8), a handoff refuses a profile that holds money or has a payment open: the one
 * rule that keeps money from being in two places. Wallet views as the engine makes them, empty and not.
 */

const empty = (): WalletView => ({ mints: [], balance: 0, history: [], feesPaid: 0 });
const network = (extra: object = {}) => ({ mints: [], balance: 0, history: [], feesPaid: 0, awaiting: [], ...extra });

describe("money keeps a profile from moving", () => {
  it("nothing in any wallet, and only past payments in the history: it moves", () => {
    expect(walletHandoffProblem(empty())).toBeNull();
    expect(walletHandoffProblem({ ...empty(), networks: { mainnet: network(), testnet: network() } as never, history: [{ id: "t", amount: 500 } as never], feesPaid: 3 })).toBeNull();
    expect(walletHandoffProblem({ ...empty(), mints: [{ url: "https://mint.test", balance: 0 } as never], wallets: [{ id: "w", type: "cashu", network: "testnet", config: {} }] })).toBeNull();
  });

  it("ecash at a mint, on either network", () => {
    expect(walletHandoffProblem({ ...empty(), balance: 21 })).toBe("wallet");
    expect(walletHandoffProblem({ ...empty(), networks: { mainnet: network(), testnet: network({ mints: [{ url: "https://mint.test", balance: 8 }] }) } as never })).toBe("wallet");
  });

  it("a wallet of any type with money: Ark, Bark, Spark, USDT, a Lightning card, on-chain", () => {
    for (const view of [
      { ark: { balance: 1 } }, { bark: { balance: 2 } }, { spark: { balance: 3 } }, { usdt: { balance: 4 } }, { bitcoin: { balance: 5 } },
      { lightnings: [{ id: "card", balance: 6 }] }, { fedimint: { federations: [{ id: "f", balance: 7 }] } }, { ark: { balance: 0, pending: 9 } },
    ]) expect(walletHandoffProblem({ ...empty(), ...view } as never), JSON.stringify(view)).toBe("wallet");
  });

  it("something a wallet waits for: an open invoice, ecash sent and not taken", () => {
    expect(walletHandoffProblem({ ...empty(), networks: { mainnet: network({ awaiting: [{ kind: "invoice" }] }), testnet: network() } as never })).toBe("wallet");
  });

  it("a payment that is not settled: pending, submitted or unknown", () => {
    for (const state of ["pending", "submitted", "unknown"]) expect(walletHandoffProblem({ ...empty(), intents: [{ state } as never] })).toBe("payment");
    expect(walletHandoffProblem({ ...empty(), intents: [{ state: "settled" } as never, { state: "failed" } as never] })).toBeNull();
  });
});
