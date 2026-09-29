/** A place that keeps encrypted bundles (WISP 1000). It only ever receives envelopes, never a key. */
export interface BackupStore {
  /** For people: "S3 · my-bucket/ghostly". */
  readonly description: string;
  put(name: string, bytes: Uint8Array): Promise<void>;
  get(name: string): Promise<Uint8Array>;
  list(space: string): Promise<StoredBackup[]>;
  remove?(name: string): Promise<void>;
}
export interface StoredBackup { name: string; size?: number; modified?: number; created: number }

/**
 * A place that can also hold items for an away contact (WISP 4xx store-and-forward): it hands out
 * addresses that read one object for a while without any credential, which is what the contact gets.
 */
export interface HoldStore extends BackupStore {
  /** A URL that reads `name` for `seconds` (at most seven days), from anywhere, with no credential. */
  presign(name: string, seconds: number): Promise<string>;
  /** The objects of one mailbox folder, `<space>/hold/<mailbox>/`. */
  listFolder(space: string, mailbox: string): Promise<StoredBackup[]>;
  remove(name: string): Promise<void>;
}
export const HELD_MEDIA_TYPE = "application/vnd.ghostly.held";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const random = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => BASE32[b % 32]).join("");

/** A profile's storage space: random, chosen once, never derived from its name or keys. */
export const newSpace = () => random(16);

/** `<space>/backups/<YYYYMMDDTHHMMSSZ>-<random>.ghostly-backup`, names that sort oldest first. */
export function backupName(space: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${space}/backups/${stamp}-${random(8)}.ghostly-backup`;
}

/** `<space>/hold/<mailbox>/<sequence, 8 digits>-<random>.ghostly-held`: one held item; the manifest is `manifest.ghostly-held`. */
export function heldName(space: string, mailbox: string, seq: number): string {
  return `${space}/hold/${mailbox}/${String(seq).padStart(8, "0")}-${random(8)}.ghostly-held`;
}
export const manifestName = (space: string, mailbox: string) => `${space}/hold/${mailbox}/manifest.ghostly-held`;

/** When a backup was made, read from its name. */
export function createdFromName(name: string): number {
  const match = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[a-z2-7]{8}\.ghostly-backup$/.exec(name);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : 0;
}
