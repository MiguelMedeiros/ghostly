import { DEFAULT_RELAYS, HoldKeys, currentRelays, isDiscoveryBudgetError, normalizeRelayUrl, peekDhtMailbox, type PkarrTransport } from "@ghostly/core";
import { databaseExists } from "../backup/database";
import { STORES, databaseName } from "../shared/idb";
import type { Settings, StoredLink } from "../shared/types";

/*
 * Checking other profiles for new messages (WISP 04 § Checking other profiles). Only the running profile is online;
 * the others' contacts keep what they send with themselves (a DHT text in their mailbox, a hold/1 pointer) until
 * that profile runs again. This looks there, now and then, for the other profiles of the device the UI names:
 *
 * - it reads what the other profile stored (its chats and settings) and never writes it;
 * - it reads the records that profile's chats would read first, over the same read path, and publishes nothing;
 * - a DHT text is opened only to tell it from a keep-alive envelope: what is kept is its id, never its words;
 * - a held item is known from the sender's pointer alone; its bundle is not fetched.
 *
 * Each profile has its own small budget of reads, so one with many chats cannot spend the requests the running
 * profile needs, and the relays' request budget (#271) is a wait: the round stops and the next one goes on.
 */

/** Reads for one profile: per round, and over any ten minutes. */
export const PEEK_LIMITS = { readsPerRound: 6, readsPerWindow: 18, windowMs: 10 * 60_000 };

/** What one round learned of one chat. `text`: the id of a DHT text waiting for it; `held`: items held for it. */
export interface PeekChat {
  linkId: string;
  /** The contact's link key, which the UI's chat list files the chat under. */
  peer: string;
  /** How far the chat had read the contact's envelopes when it last ran: a text at or below it was taken. */
  peerSequence: number;
  text: string | null;
  held: number;
}
/**
 * `missing`: no such profile database; `path`: that profile reads the network another way than this one (another
 * set of relays, or relays where this one reads the DHT), so it is not read from here; `offline`: this profile is
 * set offline; `budget`: the relays' request budget stopped the round; `rested`: this profile's own budget is spent.
 */
export interface PeekResult { status: "done" | "missing" | "path" | "offline" | "budget" | "rested"; reads: number; chats: PeekChat[] }

/**
 * How a profile reads Pkarr records: the DHT itself (Desktop, unless its relays are read too), or these relays.
 * Two profiles with the same path show the network nothing new when one reads the other's records.
 */
export function readPathOf(settings: Partial<Pick<Settings, "relays" | "readRelays">> | undefined, direct: boolean): string {
  const relays = [...new Set(currentRelays(settings?.relays?.length ? settings.relays : DEFAULT_RELAYS).map(normalizeRelayUrl).filter((r): r is string => !!r))].sort();
  if (direct) return settings?.readRelays === true ? `dht+${relays.join(",")}` : "dht";
  return relays.join(",");
}

/** A chat this looks at: a paired chat with a contact it can check envelopes against. Groups and entry sessions are not chats. */
const peekable = (link: StoredLink) => !!link.profile && !!link.participationSeed && !link.group && !link.groupEntry && !!(link.pairedPeerKey || link.peerParticipationKeyZ32);
/** What one chat may cost: its mailbox (two boxes while the contact is moving to the pinned one) and its hold pointer. */
const worstReads = (link: StoredLink) => (link.dhtDeliveryState?.peerPinned && link.dhtDeliveryState.peerPinned !== "seen" ? 2 : 1) + (holdable(link) ? 1 : 0);
const holdable = (link: StoredLink) => !!link.hold?.enabled && !!link.pairedPeerKey && !!link.participationSeed;
/** Another profile's database name (WISP 04): never an Ark wallet's or anything else of the origin. */
const PROFILE_DB = /^ghostly(_[A-Za-z0-9_-]{1,80})?$/;

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** Another profile's chats and settings, read in one read-only transaction; null when it has no database. */
export async function readProfileStore(dbName: string): Promise<{ links: StoredLink[]; settings?: Partial<Settings> } | null> {
  if (!(await databaseExists(dbName))) return null;
  // No version: an existing database opens as it is, never upgraded from here.
  const db = await request(indexedDB.open(dbName));
  // That profile starting elsewhere must not wait for this.
  db.onversionchange = () => db.close();
  try {
    const names = [STORES.links, STORES.settings].filter((name) => db.objectStoreNames.contains(name));
    if (!names.includes(STORES.links)) return { links: [] };
    const tx = db.transaction(names, "readonly");
    const links = await request(tx.objectStore(STORES.links).getAll()) as StoredLink[];
    const settings = names.includes(STORES.settings) ? await request(tx.objectStore(STORES.settings).get("settings")) as Partial<Settings> | undefined : undefined;
    return { links, settings };
  } finally { db.close(); }
}

export interface ProfilePeekHost {
  transport: PkarrTransport;
  /** This profile's read path (`readPathOf`) and whether it is online now. */
  readPath(): string;
  direct: boolean;
  online(): boolean;
  now?: () => number;
  read?: typeof readProfileStore;
}

export class ProfilePeek {
  private readonly spent = new Map<string, number[]>();
  private readonly cursor = new Map<string, number>();
  private readonly busy = new Set<string>();
  constructor(private readonly host: ProfilePeekHost) {}
  private now(): number { return this.host.now?.() ?? Date.now(); }

  /** One round for one other profile, named by its id and its database. */
  async peek(profile: string, dbName: string): Promise<PeekResult> {
    if (!PROFILE_DB.test(dbName) || dbName === databaseName()) throw new Error("Not another profile of this device");
    if (!this.host.online()) return { status: "offline", reads: 0, chats: [] };
    // Two rounds of one profile never overlap: the second would read what the first reads.
    if (this.busy.has(profile)) return { status: "rested", reads: 0, chats: [] };
    this.busy.add(profile);
    try { return await this.round(profile, dbName); } finally { this.busy.delete(profile); }
  }

  private async round(profile: string, dbName: string): Promise<PeekResult> {
    const stored = await (this.host.read ?? readProfileStore)(dbName);
    if (!stored) return { status: "missing", reads: 0, chats: [] };
    if (readPathOf(stored.settings, this.host.direct) !== this.host.readPath()) return { status: "path", reads: 0, chats: [] };
    const chats = stored.links.filter(peekable).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const out: PeekChat[] = [];
    let reads = 0;
    if (!chats.length) return { status: "done", reads, chats: out };
    const now = this.now();
    const recent = (this.spent.get(profile) ?? []).filter((at) => now - at < PEEK_LIMITS.windowMs);
    this.spent.set(profile, recent);
    const start = (this.cursor.get(profile) ?? 0) % chats.length;
    let status: PeekResult["status"] = "done";
    for (let i = 0; i < chats.length; i++) {
      const link = chats[(start + i) % chats.length];
      const left = Math.min(PEEK_LIMITS.readsPerRound - reads, PEEK_LIMITS.readsPerWindow - recent.length);
      if (left < worstReads(link)) { status = recent.length >= PEEK_LIMITS.readsPerWindow ? "rested" : "done"; break; }
      // The next round starts after the last chat looked at, so every chat gets its turn.
      this.cursor.set(profile, (start + i + 1) % chats.length);
      const count = { resolve: (key: string, options?: Parameters<PkarrTransport["resolve"]>[1]) => { recent.push(this.now()); reads++; return this.host.transport.resolve(key, options); } };
      try {
        out.push(await this.chat(link, count));
      } catch (error) {
        // The relays' budget is a wait (#271): the rest waits for the next round. A failed read skips this chat.
        if (isDiscoveryBudgetError(error)) { status = "budget"; break; }
      }
    }
    return { status, reads, chats: out };
  }

  private async chat(link: StoredLink, transport: Pick<PkarrTransport, "resolve">): Promise<PeekChat> {
    // Only reads: `peekDhtMailbox` gets a transport whose publications refuse.
    const readOnly: PkarrTransport = { resolve: transport.resolve, publish: async () => { throw new Error("A peek publishes nothing"); }, describe: () => this.host.transport.describe() };
    const { text } = await peekDhtMailbox({ params: link, credentials: { seedB64: link.participationSeed!, peerKey: link.pairedPeerKey, expectedPeerKey: link.peerParticipationKeyZ32 },
      state: link.dhtDeliveryState, transport: readOnly, background: true });
    let held = 0;
    if (holdable(link)) {
      const keys = new HoldKeys(link, link.participationSeed!, link.pairedPeerKey!);
      const packet = await transport.resolve(keys.peerAddress, { background: true });
      const now = this.now(), hold = link.hold!;
      const pointer = packet ? keys.readPointer(packet, now) : null;
      if (pointer && pointer.rev >= hold.peerPointerRev && pointer.expires > now && pointer.top > hold.inSeq) held = Math.min(pointer.count, pointer.top - hold.inSeq);
    }
    return { linkId: link.id, peer: link.peerPubKeyZ32, peerSequence: link.dhtDeliveryState?.peerSequence ?? 0, text, held };
  }
}
