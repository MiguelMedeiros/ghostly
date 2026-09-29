import type { WalletNetwork } from "@ghostly/core";
import type { NetworkWalletsView, WalletInstanceView, WalletType } from "./types";

/*
 * The backup reminder (WISP 200 § Backups): the first time a Mainnet wallet holds real money, the Wallet page asks
 * once, calmly, for a copy of it. Test coins never ask. A wallet whose money rests on a recovery phrase asks for the
 * phrase; Cashu, which has no phrase, asks for a profile backup. It ends once a copy is made: the phrase shown, a
 * backup file of it made, or a profile backup made after the money arrived. "Later" puts it off until the next
 * receive or for three days, once; a second "Later" ends it. The record is the profile's own, in the engine's
 * settings, per wallet.
 */

/** What copy a wallet's money rests on: its recovery phrase (or a backup file of it), or the whole profile's backup. */
export type BackupKind = "phrase" | "profile";

/**
 * The wallets that hold their money on this device, and their copy. Lightning is left out (through the Cashu mints it
 * is Cashu's balance; through a node of one's own, the node keeps it), and so is on-chain Bitcoin (an external source).
 */
export const BACKUP_KIND: Partial<Record<WalletType, BackupKind>> = {
  cashu: "profile", usdt: "phrase", arkade: "phrase", bark: "phrase", spark: "phrase", fedimint: "phrase",
};

/** How long a "Later" lasts when no money comes in meanwhile. */
export const LATER_MS = 3 * 24 * 60 * 60 * 1000;
/** "Later" puts it off once: the reminder comes back once, and the second "Later" ends it. */
export const LATER_LIMIT = 2;

/** One wallet's reminder, kept in the engine's settings under the wallet's id (`usdt:mainnet`). */
export interface BackupReminderRecord {
  /** When its balance was first seen above zero. */
  funded?: number;
  /** When a copy was made: the phrase shown, a backup file of it, or a profile backup once it held money. */
  backedUp?: number;
  /** When "Later" was pressed last, while it is put off. */
  later?: number;
  /** Its balance then (base units, as text): money coming in beyond it brings the reminder back. */
  laterBalance?: string;
  /** How many times "Later" was pressed. */
  laters?: number;
}
export type BackupReminders = Record<string, BackupReminderRecord>;

/** A wallet's balance now, in its own base units (sats, or the token's). */
export interface WalletBalance {
  id: string;
  type: WalletType;
  network: WalletNetwork;
  balance: bigint;
}

/** A wallet the reminder asks about now. */
export interface BackupDue {
  id: string;
  type: WalletType;
  backup: BackupKind;
}

const asks = (w: { type: WalletType; network: WalletNetwork }) => w.network === "mainnet" && BACKUP_KIND[w.type] !== undefined;
const big = (text: string | undefined): bigint | undefined => { try { return text === undefined ? undefined : BigInt(text); } catch { return undefined; } };

/**
 * The Mainnet balances the reminder watches, read from the wallets' views: only wallets that exist and say what they
 * hold (a locked or connecting one says nothing yet).
 */
export function mainnetBalances(wallets: readonly WalletInstanceView[], view: NetworkWalletsView | undefined): WalletBalance[] {
  if (!view) return [];
  const out: WalletBalance[] = [];
  for (const w of wallets) {
    if (!asks(w)) continue;
    let balance: bigint | undefined;
    switch (w.type) {
      case "cashu": balance = BigInt(Math.max(0, Math.floor(view.balance))); break;
      case "usdt": balance = view.usdt?.configured && !view.usdt.locked ? big(view.usdt.balance) : undefined; break;
      case "arkade": balance = view.ark?.configured && !view.ark.locked ? BigInt(Math.floor(view.ark.balance ?? 0)) : undefined; break;
      case "bark": balance = view.bark?.configured && !view.bark.locked ? BigInt(Math.floor(view.bark.balance ?? 0)) : undefined; break;
      case "spark": balance = view.spark?.configured && !view.spark.locked ? BigInt(Math.floor(view.spark.balance ?? 0)) : undefined; break;
      case "fedimint": balance = view.fedimint?.federations.length ? BigInt(Math.floor(view.fedimint.balance ?? 0)) : undefined; break;
    }
    if (balance !== undefined) out.push({ id: w.id, type: w.type, network: w.network, balance });
  }
  return out;
}

/**
 * What the balances now change in the records: a wallet holding money for the first time is funded; one put off with
 * "Later" comes back when more money came in than it held then (and after a spend, the mark follows the balance down).
 * `changed` is false when nothing needs saving.
 */
export function observeBalances(records: BackupReminders, balances: readonly WalletBalance[], now: number): { records: BackupReminders; changed: boolean } {
  let next = records, changed = false;
  const put = (id: string, record: BackupReminderRecord) => { next = { ...next, [id]: record }; changed = true; };
  for (const { id, balance, ...w } of balances) {
    if (!asks(w)) continue;
    const record = next[id] ?? {};
    if (balance > 0n && record.funded === undefined) { put(id, { ...record, funded: now }); continue; }
    const mark = big(record.laterBalance);
    if (record.later === undefined || mark === undefined) continue;
    if (balance > mark) { const { later: _l, laterBalance: _b, ...rest } = record; put(id, rest); }
    else if (balance < mark) put(id, { ...record, laterBalance: balance.toString() });
  }
  return { records: next, changed };
}

/** The wallets to remind about now, in the order given (the deck's). */
export function backupDue(records: BackupReminders | undefined, wallets: readonly Pick<WalletInstanceView, "id" | "type" | "network">[] | undefined, now: number): BackupDue[] {
  if (!records || !wallets) return [];
  return wallets.flatMap((w) => {
    const record = records[w.id], backup = BACKUP_KIND[w.type];
    if (!record || !backup || w.network !== "mainnet") return [];
    if (record.funded === undefined || record.backedUp !== undefined) return [];
    if ((record.laters ?? 0) >= LATER_LIMIT) return [];
    if (record.later !== undefined && now - record.later < LATER_MS) return [];
    return [{ id: w.id, type: w.type, backup }];
  });
}

/**
 * A copy was made. `phrase`: one wallet's phrase shown or its backup file made (`id`), at any time: the phrase does
 * not change with the money. `profile`: a profile backup, which holds every wallet as it is now: it counts for the
 * wallets that already hold money, not for money that comes later to a wallet that had none.
 */
export function markBackedUp(records: BackupReminders, made: { kind: "phrase"; id: string } | { kind: "profile" }, now: number): BackupReminders {
  if (made.kind === "phrase") return { ...records, [made.id]: { ...records[made.id], backedUp: now } };
  const next = { ...records };
  for (const [id, record] of Object.entries(records)) if (record.funded !== undefined && record.backedUp === undefined) next[id] = { ...record, backedUp: now };
  return next;
}

/** "Later" on a wallet's reminder: put off until the next receive or `LATER_MS`, once; the second ends it. */
export function putOff(records: BackupReminders, id: string, balance: bigint, now: number): BackupReminders {
  const record = records[id] ?? {};
  const laters = (record.laters ?? 0) + 1;
  return { ...records, [id]: { ...record, laters, later: now, laterBalance: balance.toString() } };
}

/** A wallet removed: its reminder goes with it (a new wallet of the kind has a new phrase, and asks again). */
export function forgetWallet(records: BackupReminders, id: string): BackupReminders {
  if (!(id in records)) return records;
  const { [id]: _gone, ...rest } = records;
  return rest;
}
