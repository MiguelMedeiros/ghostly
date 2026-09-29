import type { WalletNetwork } from "@ghostly/core";
import type { WalletOffer, WalletSetupRecord, WalletSetupView, WalletType } from "../shared/types";

/**
 * What a new profile gets by itself on Mainnet, in this order: payments over Lightning (Cashu), a dollar token (USDT),
 * and Bitcoin on-chain. A kind with no Mainnet wallet here yet (on-chain, until a Mainnet source that needs no form
 * exists) is skipped quietly and stays in the list, never shown as a failure.
 */
export const DEFAULT_WALLETS: readonly WalletType[] = ["cashu", "usdt", "bitcoin"];
/** The network the first-run setup makes wallets on: real money, to receive right away. */
export const SETUP_NETWORK: WalletNetwork = "mainnet";

export interface WalletSetupHost {
  /** The record as stored (absent: never set up). */
  record(): WalletSetupRecord | undefined;
  save(record: WalletSetupRecord): Promise<void>;
  /** What New can make of this kind on Mainnet now (read afresh). */
  offer(type: WalletType): Promise<WalletOffer | undefined>;
  /** Makes it, with the network's defaults, as New's one click does (checked before it counts as made). */
  create(type: WalletType): Promise<void>;
  /** The view changed: the page hears of it. */
  changed(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The first-run wallet setup: a new profile gets its default Mainnet wallets in the background, once. What is made is
 * never made again, so a wallet the person removes stays removed. A kind that could not be made (a server down, no
 * network) keeps its reason for the Wallet page and is tried again quietly at the next start, or when the person asks.
 * Creating a wallet moves no money.
 */
export class WalletSetup {
  private running: Promise<void> | null = null;

  constructor(private readonly host: WalletSetupHost) {}

  /** What the Wallet page shows: absent when there is nothing to say (done, or waiting only on a kind not offered). */
  view(): WalletSetupView | undefined {
    const record = this.host.record();
    const failed = (record?.left ?? []).flatMap((type) => {
      const reason = record?.failed?.[type];
      return reason ? [{ type, network: SETUP_NETWORK, reason }] : [];
    });
    if (!this.running && !failed.length) return undefined;
    return { running: !!this.running, failed };
  }

  /**
   * At start. `fresh`: a new profile (nothing stored yet, no wallet, no chat). Only then is a setup begun; a profile
   * with a record goes on with what is left; any other profile (one from before this, or whose wallets were removed)
   * is left alone.
   */
  async begin(fresh: boolean): Promise<void> {
    if (!this.host.record()) {
      if (!fresh) return;
      // Written before anything is tried: a reload from here on never takes this profile for a new one again.
      await this.host.save({ left: [...DEFAULT_WALLETS] });
    }
    await this.run();
  }

  /** Tries what is left (or only `only`), one after the other. A run under way is joined, not doubled. */
  run(only?: WalletType): Promise<void> {
    if (this.running) return this.running;
    this.running = this.work(only).finally(() => { this.running = null; this.host.changed(); });
    this.host.changed();
    return this.running;
  }

  /** A wallet of this kind was made on this network (by the setup or by the person): nothing left to make of it. */
  async made(type: WalletType, network: WalletNetwork): Promise<void> {
    if (network === SETUP_NETWORK) await this.drop(type);
  }

  /** The person does not want this kind made for them: it is not tried again. */
  async dismiss(type: WalletType): Promise<void> {
    await this.drop(type);
    this.host.changed();
  }

  private async work(only?: WalletType): Promise<void> {
    for (const type of [...this.host.record()?.left ?? []]) {
      if (only && type !== only) continue;
      const offer = await this.host.offer(type);
      if (offer?.exists) { await this.drop(type); continue; }
      // Not made here yet (no Mainnet source), or it asks for something (a form, a key): it waits, and says nothing.
      if (!offer?.available || offer.needs) continue;
      try {
        await this.host.create(type);
        await this.drop(type);
      } catch (error) {
        const record = this.host.record();
        if (record?.left.includes(type)) await this.host.save({ ...record, failed: { ...record.failed, [type]: message(error) } });
      }
      this.host.changed();
    }
  }

  private async drop(type: WalletType): Promise<void> {
    const record = this.host.record();
    if (!record?.left.includes(type)) return;
    const failed = { ...record.failed };
    delete failed[type];
    await this.host.save({ left: record.left.filter((t) => t !== type), ...(Object.keys(failed).length ? { failed } : {}) });
  }
}
