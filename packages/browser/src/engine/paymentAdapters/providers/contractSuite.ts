import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBolt11, isBitcoinAddress } from "@ghostly/core";
import type { LightningInvoice, LightningProvider, LightningProviderDescriptor } from "./lightning";
import type { OnchainProvider, OnchainProviderDescriptor } from "./onchain";
import { isNothingSpentError, providerDescriptorProblems, type ProviderDescriptor, type ProviderNetwork } from "./types";

/**
 * The provider contract as tests: every Lightning or on-chain provider runs these against itself, with a
 * harness that knows how to make money move on its network (a fake, a regtest counterpart node, a
 * faucet). See PROVIDERS.md. A provider's own unit tests (mocked transport) go next to these.
 *
 *   describeLightningProvider("NWC", async () => ({ provider, network: "regtest", payIncoming, payable }));
 */
export interface LightningHarness {
  provider: LightningProvider;
  network: ProviderNetwork;
  /** The descriptor the app would register: its shape is checked too. */
  descriptor?: LightningProviderDescriptor;
  /** Someone else pays this invoice of the provider (a counterpart node; a fake marks it paid). */
  payIncoming(invoice: LightningInvoice): Promise<void>;
  /** An invoice of someone else for `amount` sats, that the provider can pay. */
  payable(amount: number): Promise<string>;
  /** An invoice the provider must refuse before anything leaves (no route, not enough funds). */
  refused?(): Promise<string>;
}

export function describeLightningProvider(name: string, make: () => Promise<LightningHarness>, { timeout = 10_000 } = {}) {
  describe(`${name}: the LightningProvider contract`, () => {
    let harness: LightningHarness | undefined;
    const open = async () => (harness = await make());
    afterEach(async () => { await harness?.provider.close(); harness = undefined; });

    it("has a well-formed descriptor, when it brings one", async () => {
      const { descriptor, network } = await open();
      if (!descriptor) return;
      expect(providerDescriptorProblems(descriptor as ProviderDescriptor<unknown>)).toEqual([]);
      expect(descriptor.kind).toBe("lightning");
      expect(descriptor.networks).toContain(network);
    });

    it("says which network it is on, and a whole-sat balance when it has one", async () => {
      const { provider, network } = await open();
      const info = await provider.info();
      expect(info.network).toBe(network);
      if (provider.capabilities.balance) expect(Number.isSafeInteger(info.balance) && info.balance! >= 0).toBe(true);
    });

    it("creates an invoice that decodes to what was asked, and sees it paid", async () => {
      const { provider, payIncoming } = await open();
      if (!provider.capabilities.receive) return;
      const invoice = await provider.createInvoice(21, "contract");
      const decoded = decodeBolt11(invoice.invoice);
      expect(decoded?.amountSat).toBe(21);
      expect(invoice.amount).toBe(21);
      expect(decoded?.paymentHash).toBe(invoice.paymentHash);
      expect(invoice.expiresAt).toBeGreaterThan(Date.now());
      if (!provider.capabilities.lookup) return;
      expect((await provider.invoiceStatus(invoice)).state).toBe("open");
      await payIncoming(invoice);
      await vi.waitFor(async () => expect((await provider.invoiceStatus(invoice)).state).toBe("paid"), { timeout, interval: 250 });
    });

    it("pays an invoice within the fee limit, and says so again when asked", async () => {
      const { provider, payable } = await open();
      if (!provider.capabilities.send) return;
      const invoice = await payable(25);
      const hash = decodeBolt11(invoice)!.paymentHash!;
      const maxFee = provider.estimateFee ? await provider.estimateFee(invoice, 25) : 10;
      const result = await provider.payInvoice(invoice, maxFee);
      if (result.state === "paid") expect(result.fee ?? 0).toBeLessThanOrEqual(maxFee);
      if (!provider.capabilities.lookup) return;
      await vi.waitFor(async () => expect((await provider.paymentStatus({ invoice, paymentHash: hash, ref: result.ref })).state).toBe("paid"), { timeout, interval: 250 });
    });

    it("refuses what it cannot pay with NothingSpentError, before anything leaves", async () => {
      const { provider, refused } = await open();
      if (!provider.capabilities.send || !refused) return;
      // By name, as the engine does: a provider built outside the app may carry its own copy of the class.
      await expect(provider.payInvoice(await refused(), 10)).rejects.toSatisfy((error: unknown) => isNothingSpentError(error));
    });
  });
}

export interface OnchainHarness {
  provider: OnchainProvider;
  network: ProviderNetwork;
  /** The descriptor the app would register: its shape is checked too. */
  descriptor?: OnchainProviderDescriptor;
  /** An address of someone else on this network. */
  recipient(): Promise<string> | string;
  /** Makes the provider's wallet hold at least `amount` confirmed sats (a faucet, mining on regtest). */
  fund?(amount: number): Promise<void>;
}

export function describeOnchainProvider(name: string, make: () => Promise<OnchainHarness>, { timeout = 10_000 } = {}) {
  describe(`${name}: the OnchainProvider contract`, () => {
    let harness: OnchainHarness | undefined;
    const open = async () => (harness = await make());
    afterEach(async () => { await harness?.provider.close(); harness = undefined; });

    it("has a well-formed descriptor, when it brings one", async () => {
      const { descriptor, network } = await open();
      if (!descriptor) return;
      expect(providerDescriptorProblems(descriptor as ProviderDescriptor<unknown>)).toEqual([]);
      expect(descriptor.kind).toBe("onchain");
      expect(descriptor.networks).toContain(network);
    });

    it("gives fresh addresses of its own network, and a whole-sat balance", async () => {
      const { provider, network } = await open();
      expect((await provider.info()).network).toBe(network);
      const [a, b] = [await provider.receiveAddress(), await provider.receiveAddress()];
      expect(isBitcoinAddress(a, network) && isBitcoinAddress(b, network)).toBe(true);
      expect(a).not.toBe(b);
      const balance = await provider.balance();
      expect(Number.isSafeInteger(balance.confirmed) && Number.isSafeInteger(balance.unconfirmed)).toBe(true);
    });

    it("refuses a fee above the cap when preparing, and spends nothing by preparing", async () => {
      const { provider, recipient, fund } = await open();
      await fund?.(20_000);
      const before = await provider.balance();
      await expect(provider.prepareSend({ address: await recipient(), amount: 1_000, feeCap: 0 })).rejects.toThrow();
      expect((await provider.balance()).confirmed).toBe(before.confirmed);
    });

    it("broadcasts exactly the prepared transaction, and broadcasting it again pays nothing more", async () => {
      const { provider, recipient, fund } = await open();
      await fund?.(20_000);
      const address = await recipient();
      const prepared = await provider.prepareSend({ address, amount: 1_000, feeCap: 5_000 });
      expect(prepared).toMatchObject({ address, amount: 1_000 });
      expect(prepared.fee).toBeLessThanOrEqual(5_000);
      expect(prepared.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(await provider.broadcast(prepared)).toBe(prepared.txid);
      const after = await provider.balance();
      await provider.broadcast(prepared).catch(() => {}); // A node may answer "already known": still the same transaction.
      expect((await provider.balance()).confirmed + (await provider.balance()).unconfirmed).toBe(after.confirmed + after.unconfirmed);
      await vi.waitFor(async () => expect(["mempool", "confirmed"]).toContain((await provider.status(prepared)).state), { timeout, interval: 250 });
      expect((await provider.history(10)).some((tx) => tx.txid === prepared.txid)).toBe(true);
    });
  });
}
