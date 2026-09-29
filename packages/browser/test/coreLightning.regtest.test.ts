import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { decodeBolt11 } from "@ghostly/core";
// @ts-expect-error: a plain script, shared with the e2e test
import { CLN_REGTEST, nodeId, rune, spendable } from "../../../e2e/support/cln-regtest/regtest.mjs";
import { CommandoClient, CommandoError, type SocketFactory } from "../src/engine/paymentAdapters/providers/commando";
import { CoreLightning, checkRune } from "../src/engine/paymentAdapters/providers/coreLightning";
import { NothingSpentError } from "../src/engine/paymentAdapters/providers/types";
import { describeLightningProvider } from "./helpers/providerContract";
// covers-gated: wallet.lightning.cln.connect, wallet.lightning.cln.pay, wallet.lightning.provider-contract

/**
 * Against real Core Lightning nodes on regtest (e2e/infra, driven by e2e/support/cln-regtest): alice is the source under test,
 * bob the counterpart on the other end of their channel. Worthless coins; runes are made fresh and never
 * printed. Skipped unless GHOSTLY_CLN_REGTEST=1.
 */
const enabled = process.env.GHOSTLY_CLN_REGTEST === "1";
type Node = "alice" | "bob";
const settings = (node: Node) => ({ url: CLN_REGTEST[node].websocket as string, nodeId: nodeId(node) as string, rune: rune(node) as string });
// Node's own WebSocket sends lower-case headers, which Core Lightning's listener does not accept (browsers
// send them as it expects): `ws` stands in for the browser's.
const socket: SocketFactory = (url) => new WebSocket(url) as never;
const connect = (node: Node, overrides: Partial<ReturnType<typeof settings>> = {}) => CoreLightning.connect({ ...settings(node), ...overrides }, undefined, socket);

// Real nodes, runes made through docker exec: seconds, not milliseconds.
describe.skipIf(!enabled)("Core Lightning on regtest", { timeout: 60_000 }, () => {
  describeLightningProvider("Core Lightning", async () => {
    const provider = connect("alice"), bob = connect("bob");
    return {
      provider, network: "regtest",
      payIncoming: async (invoice) => { await bob.payInvoice(invoice.invoice, 10); },
      payable: async (amount) => (await bob.createInvoice(amount, "contract")).invoice,
      // More than the channel can carry: no route, before any HTLC.
      refused: async () => (await bob.createInvoice(5_000_000, "too much")).invoice,
    };
  }, { timeout: 30_000 });

  it("is refused a method its rune does not allow, and the node's answer is final", async () => {
    const client = new CommandoClient({ ...settings("alice"), rune: rune("alice", ["getinfo"]), socket });
    try {
      expect((await client.call<{ network: string }>("getinfo")).network).toBe("regtest");
      const error = await client.call("listfunds").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CommandoError);
      // A rune for getinfo alone is still not one Ghostly takes: it cannot pay or receive.
      expect(() => checkRune(rune("alice", ["getinfo", "withdraw"]))).toThrow(/not restricted/);
    } finally { await client.close(); }
  });

  it("refuses a wrong node id at the handshake", async () => {
    const wrong = connect("alice", { nodeId: nodeId("bob") as string });
    await expect(wrong.info()).rejects.toThrow(/handshake|closed/);
    await wrong.close();
  });

  it("an invoice paid from the other side moves the balance on both nodes", async () => {
    const alice = connect("alice"), bob = connect("bob");
    try {
      const before = { alice: (await alice.info()).balance!, bob: (await bob.info()).balance! };
      const invoice = await alice.createInvoice(1234, "both sides");
      expect(decodeBolt11(invoice.invoice)?.network).toBe("regtest");
      const paid = await bob.payInvoice(invoice.invoice, 10);
      expect(paid.state).toBe("paid");
      expect((await alice.invoiceStatus(invoice))).toEqual({ state: "paid", amount: 1234 });
      expect(await bob.paymentStatus({ invoice: invoice.invoice, paymentHash: invoice.paymentHash })).toMatchObject({ state: "paid" });
      expect((await alice.info()).balance).toBe(before.alice + 1234);
      expect((await bob.info()).balance).toBe(before.bob - 1234 - (paid.state === "paid" ? paid.fee ?? 0 : 0));
      // Paying it again is refused by the node, and the payment is still the one that went through.
      await expect(bob.payInvoice(invoice.invoice, 10)).resolves.toMatchObject({ state: "paid" });
      expect((await bob.info()).balance).toBe(before.bob - 1234);
      expect(spendable("alice")).toBeGreaterThan(0);
    } finally { await alice.close(); await bob.close(); }
  });

  it("says NothingSpentError for an invoice of a node nobody can route to", async () => {
    const alice = connect("alice");
    try {
      const { strangerInvoice } = await import("../../../e2e/support/bolt11");
      const invoice = strangerInvoice(50, "nobody", "lnbcrt");
      await expect(alice.payInvoice(invoice, 10)).rejects.toBeInstanceOf(NothingSpentError);
      expect(await alice.paymentStatus({ invoice, paymentHash: decodeBolt11(invoice)!.paymentHash! })).toMatchObject({ state: expect.stringMatching(/failed|pending/) });
    } finally { await alice.close(); }
  });
});
