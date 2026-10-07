/** How long a dial whose stream opened may go without the contact's preface before it is dialled again. */
export const PREFACE_WAIT_MS: number;
/** At most this many dials for one connect: the first, and two more if they stalled. */
export const MAX_DIALS: number;

export interface Dial<T extends { channel: { close(): void } }> {
  /** True once the stream is open (the handshake is done). */
  opened: Promise<boolean>;
  /** The bound channel, once the contact's preface came. */
  ready: Promise<T>;
  /** Drops this dial. */
  close(): void;
}

/** Dials until one brings the contact's preface; a dial that opened and brought none within `waitMs` is made again. */
export function redial<T extends { channel: { close(): void } }>(dialOnce: () => Dial<T>, options?: { waitMs?: number; maxDials?: number }): Promise<T>;
