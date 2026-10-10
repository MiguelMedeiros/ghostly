/** How long a dial whose stream opened may go without the contact's preface before it is dialled again. */
export const PREFACE_WAIT_MS: number;
/** The longest a stream on a slow path waits for the preface. */
export const PREFACE_MAX_WAIT_MS: number;
/** How many of the path's smoothed round trips the preface may take. */
export const RTT_FACTOR: number;
/** Before the stream's first RTT sample, how many times the dial's opening the preface may take. */
export const OPENING_FACTOR: number;
/** At most this many dials for one connect: the first, and two more if they stalled. */
export const MAX_DIALS: number;

/** The preface wait for a stream whose smoothed RTT is `rtt` ms (0: no sample yet) and whose dial took `opening` ms to open. */
export function prefaceWait(rtt: number | undefined, opening?: number, floor?: number, ceiling?: number): number;

export interface Dial<T extends { channel: { close(): void } }> {
  /** True once the stream is open (the handshake is done). */
  opened: Promise<boolean>;
  /** The bound channel, once the contact's preface came. */
  ready: Promise<T>;
  /** Drops this dial. */
  close(): void;
  /** The stream's smoothed RTT in ms so far, 0 before the first sample. */
  rtt?(): number;
}

/** Dials until one brings the contact's preface; a dial that opened and brought none in time is made again. */
export function redial<T extends { channel: { close(): void } }>(dialOnce: () => Dial<T>, options?: { waitMs?: number; maxWaitMs?: number; maxDials?: number }): Promise<T>;
