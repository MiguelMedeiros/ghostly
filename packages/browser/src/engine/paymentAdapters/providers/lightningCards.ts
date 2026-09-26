import { STORES, transact } from "../../../shared/idb";
import type { WalletMode } from "../../../shared/mints";
import { CASHU_MINT_SOURCE } from "./cashuMint";
import type { LightningProviderDescriptor } from "./lightning";
import { LightningService, readLightningJournal, type LightningEvents, type LightningOp, type LightningView } from "./lightningService";
import { sourceKey } from "./sources";
import type { ProviderHost } from "./types";

/**
 * One Lightning card of a network, as stored under `lightningCards-<network>`. Its source (and the source's sealed
 * secrets) is stored apart, under `lightningSource-<network>-<key>`: the card that took over a network's one source
 * (`LEGACY_CARD`) has no key and keeps reading `lightningSource-<network>`, where that source always was.
 */
export interface StoredLightningCard {
  id: string;
  name: string;
  providerId: string;
  /** Where its source is stored. Absent: the network's one key (the card made from it). */
  key?: string;
  createdAt: number;
}
interface StoredLightningCards {
  cards: StoredLightningCard[];
  /** The card a chat request's invoice and Receive come from, unless another is picked. */
  receive: string;
}

/** A Lightning card as the pages see it: its source's view, its name, and whether it is the one receiving. */
export interface LightningCardView extends LightningView {
  card: string;
  name: string;
  /** The network's default for receiving: chat requests and Receive use it unless another card is picked. */
  receive: boolean;
}

/** The card of Lightning through the Cashu mints: at most one per network, shown while the network has mints. */
export const CASHU_CARD = "cashu";
/** The card made from the one source a network had before it could have several. */
export const LEGACY_CARD = "main";
export const cardsKey = (network: WalletMode) => `lightningCards-${network}`;
const NAME_MAX = 32;

/** Short source names for a card's default name ("Alby Hub (NWC)"): the form's label otherwise. */
const SHORT: Record<string, string> = { nwc: "NWC", lnd: "LND", "core-lightning": "Core Lightning", breez: "Breez", [CASHU_MINT_SOURCE]: "Cashu", fedimint: "Fedimint", webln: "WebLN" };

/**
 * The cards of a network, made the first time this version opens it from what an older one kept: the network's one
 * source (`lightningSource-<network>`) becomes a card reading that same key, so no secret moves and nothing asks
 * again; with no source saved, the network used the Cashu mints, and that is its card. Either becomes the default for
 * receiving. Read and written in one transaction; a second run finds the cards and changes nothing. Never reads a
 * secret: the source's record names its provider next to its sealed secrets.
 */
export async function loadLightningCards(network: WalletMode, label: (providerId: string) => string, now = Date.now()): Promise<StoredLightningCards> {
  let result: StoredLightningCards | undefined;
  await transact([STORES.settings], (stores) => {
    const settings = stores[STORES.settings];
    const saved = settings.get(cardsKey(network));
    saved.onsuccess = () => {
      const found = saved.result as StoredLightningCards | undefined;
      if (found?.cards?.length) { result = found; return; }
      const legacy = settings.get(sourceKey("lightning", network));
      legacy.onsuccess = () => {
        const providerId = (legacy.result as { providerId?: unknown } | undefined)?.providerId;
        const card: StoredLightningCard = typeof providerId === "string" && providerId && providerId !== CASHU_MINT_SOURCE
          ? { id: LEGACY_CARD, name: shortName(providerId, label), providerId, createdAt: now }
          : cashuCard(now);
        result = { cards: [card], receive: card.id };
        settings.put(result, cardsKey(network));
      };
    };
  });
  return result!;
}

const cashuCard = (now: number): StoredLightningCard => ({ id: CASHU_CARD, name: SHORT[CASHU_MINT_SOURCE], providerId: CASHU_MINT_SOURCE, key: CASHU_CARD, createdAt: now });
const shortName = (providerId: string, label: (providerId: string) => string) => SHORT[providerId] ?? label(providerId);

export interface LightningCardsHost {
  descriptors: () => readonly LightningProviderDescriptor[];
  host: () => Omit<ProviderHost, "mode" | "signal">;
  events: LightningEvents;
  /** Whether the network has Cashu mints: the Cashu card shows only then. */
  hasMints: () => boolean;
  fetch?: typeof fetch;
}

/**
 * The Lightning cards of one network, each with its own source, balance and journal: "Alby Hub (NWC)", "Home LND",
 * the Cashu mints. A payment goes through the card picked for it; a chat request's invoice and Receive come from the
 * default for receiving unless another is picked. Adding, removing and renaming are serialized.
 */
export class LightningCards {
  private stored: StoredLightningCards = { cards: [], receive: CASHU_CARD };
  private readonly services = new Map<string, LightningService>();
  private queue: Promise<unknown> = Promise.resolve();
  /** A card being added: a creation that takes too long cuts its connection short. */
  private adding?: LightningService;
  private stopped = false;

  constructor(readonly network: WalletMode, private readonly options: LightningCardsHost) {}

  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next; }
  private label = (providerId: string) => this.options.descriptors().find((d) => d.id === providerId)?.label ?? providerId;

  private make(card: StoredLightningCard): LightningService {
    return new LightningService(this.network, this.options.descriptors, this.options.host, this.options.events,
      card.providerId === CASHU_MINT_SOURCE ? CASHU_MINT_SOURCE : undefined,
      { fetch: this.options.fetch, card: card.id, key: card.key, owns: (op) => this.owner(op) === card.id });
  }

  private starting?: Promise<void>;
  /** Opens the cards (once: a use before the engine started opens them too). */
  start(): Promise<void> { return this.starting ??= this.open(); }
  private async open() {
    this.stored = await loadLightningCards(this.network, this.label);
    for (const card of this.stored.cards) {
      const service = this.make(card);
      this.services.set(card.id, service);
      await service.start();
    }
  }

  /**
   * The card an operation went through. One journaled before cards: the Cashu card's when the mints made it, else the
   * card made from the network's one source (none, when that source was replaced before cards: nobody shows it).
   */
  owner(op: LightningOp): string {
    if (op.card !== undefined) return op.card;
    return op.providerId === CASHU_MINT_SOURCE ? CASHU_CARD : LEGACY_CARD;
  }

  /** The cards a person sees: the Cashu card only while the network has mints. In the order they were added. */
  private shown(): StoredLightningCard[] { return this.stored.cards.filter((c) => c.id !== CASHU_CARD || this.options.hasMints()); }

  /** The default for receiving, or the first card shown when that one is not (the Cashu card of a network with no mints). */
  get receivingId(): string {
    const shown = this.shown();
    return shown.find((c) => c.id === this.stored.receive)?.id ?? shown[0]?.id ?? this.stored.receive;
  }
  get receiving(): LightningService { return this.services.get(this.receivingId) ?? [...this.services.values()][0]; }

  /** A card by its id; without one, the default for receiving. Throws when it is gone. */
  card(id?: string): LightningService {
    if (id === undefined) { if (!this.services.size) throw new Error("Lightning is not open yet"); return this.receiving; }
    const service = this.services.get(id);
    if (!service) throw new Error("That Lightning card is gone: pick another");
    return service;
  }
  has(id: string) { return this.services.has(id); }
  all(): LightningService[] { return [...this.services.values()]; }

  views(): LightningCardView[] {
    const receive = this.receivingId;
    return this.shown().filter((card) => this.services.has(card.id)).map((card) => ({ ...this.services.get(card.id)!.view, card: card.id, name: card.name, receive: card.id === receive }));
  }
  /** The default for receiving's view: what a caller from before cards reads as the network's Lightning. None before start. */
  get view(): LightningCardView | undefined {
    const card = this.stored.cards.find((c) => c.id === this.receivingId) ?? this.stored.cards[0];
    return card && this.services.has(card.id) ? { ...this.services.get(card.id)!.view, card: card.id, name: card.name, receive: true } : undefined;
  }

  /** The card holding this quote (each card quotes through its own source). */
  withQuote(quote: string): LightningService | undefined { return this.all().find((s) => s.hasQuote(quote)); }

  /**
   * Adds a card with `providerId` and the values of its form: connected and checked first, like any source; only then
   * saved. Nothing is saved when it fails. The same wallet twice (same source, same settings) is refused. A card of the
   * person's own takes receiving over from the mints' card (what a source chosen before cards did); next to another
   * card of their own, the default stays.
   */
  add(providerId: string, values: Record<string, string>): Promise<string> {
    return this.serial(async () => {
      if (providerId === CASHU_MINT_SOURCE) {
        if (this.services.has(CASHU_CARD)) throw new Error("Lightning through your Cashu mints is already a card");
        if (!this.options.hasMints()) throw new Error("Create a Cashu wallet first: this card pays and receives through its mints");
        const card = cashuCard(Date.now());
        const service = this.make(card);
        await service.start();
        await this.save({ ...this.stored, cards: [...this.stored.cards, card] }, card.id);
        this.services.set(card.id, service);
        void service.ensureReady();
        return card.id;
      }
      const id = `ln-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      const card: StoredLightningCard = { id, name: "", providerId, key: id, createdAt: Date.now() };
      const service = this.make(card);
      const same = await this.findSame(providerId, values);
      if (same) throw new Error(`That wallet is already your card “${this.stored.cards.find((c) => c.id === same)?.name}”`);
      await service.start();
      this.adding = service;
      try { await service.sources.set(providerId, values); }
      catch (error) { await service.stop(); throw error; }
      finally { this.adding = undefined; }
      card.name = this.freeName(service.view.alias ? `${service.view.alias.slice(0, 20)} (${shortName(providerId, this.label)})` : shortName(providerId, this.label));
      const receive = this.receivingId === CASHU_CARD ? id : this.stored.receive;
      try { await this.save({ cards: [...this.stored.cards, card], receive }, card.id); }
      catch (error) { await service.sources.forget().catch(() => {}); await service.stop(); throw error; }
      this.services.set(id, service);
      return id;
    });
  }

  /** The card that is already this wallet (the same source with the same settings), if one is. Throws what to fix in the form. */
  async findSame(providerId: string, values: Record<string, string>): Promise<string | undefined> {
    const { settings } = this.receiving.sources.settingsOf(providerId, values);
    for (const [id, service] of this.services) if (await service.sources.holds(providerId, settings)) return id;
    return undefined;
  }

  /** A name no other card of the network has: "LND", then "LND 2". */
  private freeName(name: string): string {
    const taken = new Set(this.stored.cards.map((c) => c.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
  }

  /**
   * Removes a card: its source and sealed secrets go (refused while a payment through it has not ended). The default
   * for receiving moves to the first card of the person's own left, else the mints' card. A network left with no card gets the Cashu card back, as before cards.
   */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const service = this.services.get(id);
      if (!service) throw new Error("That Lightning card is gone");
      await service.sources.forget();
      await service.stop();
      this.services.delete(id);
      let cards = this.stored.cards.filter((c) => c.id !== id);
      let added: LightningService | undefined;
      if (!cards.length) {
        const card = cashuCard(Date.now());
        cards = [card];
        added = this.make(card);
        this.services.set(card.id, added);
        await added.start();
      }
      const shown = cards.filter((c) => c.id !== CASHU_CARD || this.options.hasMints());
      const next = shown.find((c) => c.id !== CASHU_CARD) ?? shown[0] ?? cards[0];
      const receive = this.stored.receive === id || !cards.some((c) => c.id === this.stored.receive) ? next.id : this.stored.receive;
      await this.save({ cards, receive });
      if (added) void added.ensureReady();
    });
  }

  /** Makes a card the network's default for receiving. */
  setReceive(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.shown().some((c) => c.id === id)) throw new Error("That Lightning card is gone");
      await this.save({ ...this.stored, receive: id });
    });
  }

  /** Renames a card: 1 to 32 characters, unique on its network. */
  rename(id: string, name: string): Promise<void> {
    return this.serial(async () => {
      const clean = name.replace(/\s+/g, " ").trim();
      if (!clean) throw new Error("Enter a name");
      if (clean.length > NAME_MAX) throw new Error(`At most ${NAME_MAX} characters`);
      if (!this.services.has(id)) throw new Error("That Lightning card is gone");
      if (this.stored.cards.some((c) => c.id !== id && c.name.toLowerCase() === clean.toLowerCase())) throw new Error("Another card has that name");
      await this.save({ ...this.stored, cards: this.stored.cards.map((c) => (c.id === id ? { ...c, name: clean } : c)) });
    });
  }

  private async save(next: StoredLightningCards, receiveIfNone?: string) {
    const shown = next.cards.filter((c) => c.id !== CASHU_CARD || this.options.hasMints());
    // A first card shown takes the receiving over from one that is not (the Cashu card of a network with no mints).
    const receive = receiveIfNone && !shown.some((c) => c.id === next.receive) ? receiveIfNone : next.receive;
    const stored = { cards: next.cards, receive };
    await transact([STORES.settings], (s) => { s[STORES.settings].put(stored, cardsKey(this.network)); });
    this.stored = stored;
    this.options.events.changed();
  }

  // -- the Cashu wallet reports what its mints settled -------------------------------

  private async ownerOf(direction: LightningOp["direction"], invoice: string): Promise<LightningService> {
    const op = (await readLightningJournal()).find((o) => o.direction === direction && o.invoice === invoice && o.mode === this.network);
    const owner = op ? this.owner(op) : CASHU_CARD;
    return (owner && this.services.get(owner)) || this.services.get(CASHU_CARD) || this.receiving;
  }
  async reportInvoicePaid(invoice: string, context: { paymentId?: string; mint?: string } = {}) { await (await this.ownerOf("in", invoice)).reportInvoicePaid(invoice, context); }
  async reportPaymentResolved(invoice: string, paid: boolean, context: { paymentId?: string; mint?: string } = {}) { await (await this.ownerOf("out", invoice)).reportPaymentResolved(invoice, paid, context); }

  // -- Lightning addresses: resolved by one card, and the invoice asked by that same one --------

  resolveDestination(text: string) { return this.receiving.resolveDestination(text); }
  destinationInvoice(id: string, amountSat: number, comment?: string) { return (this.all().find((s) => s.hasDestination(id)) ?? this.receiving).destinationInvoice(id, amountSat, comment); }

  // -- every card at once -----------------------------------------------------------

  list() { return readLightningJournal(); }
  async reconcile() { await Promise.all(this.all().map((s) => s.reconcile())); }
  async recover() { for (const s of this.all()) await s.recover(); }
  async ensureReady() { await Promise.all(this.all().map((s) => s.ensureReady())); }
  refreshOffered() { for (const s of this.all()) s.refreshOffered(); }
  wake() { for (const s of this.all()) s.sources.wake(); }
  cutShort() { this.adding?.sources.cutShort(); }
  resume() { this.adding?.sources.resume(); }
  async stop() { this.stopped = true; for (const s of this.all()) await s.stop(); }
  get isStopped() { return this.stopped; }
}
