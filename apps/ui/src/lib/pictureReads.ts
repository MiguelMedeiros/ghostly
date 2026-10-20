/**
 * The pictures a chat shows (FileBubble), read whole from where the files are kept: on Desktop and Android over IPC,
 * a step at a time. A chat opens with up to a hundred bubbles at once, so a picture is read only once its bubble is on
 * screen (the bubble decides), a few at a time, and the last ones read are kept for this run of the app: a chat opened
 * again reads none of them.
 */

/** A picture read here: its bytes and the `blob:` address a bubble shows. Given back with `release` once unshown. */
export type HeldPicture = { url: string; blob: Blob; release: () => void };

/** Reads at once. Each holds a whole file in the page while it comes. */
const READING = 3;
/** Kept for the run besides those on screen: a few dozen, and no more bytes than this. */
const KEPT = 48;
const KEPT_BYTES = 128 * 1024 ** 2;

type Kept = { url: string; blob: Blob; shown: number; dropped: boolean };
/** By file id, the least recently shown first. */
const kept = new Map<string, Kept>();
let reading = 0;
const turns: (() => void)[] = [];
/** A turn given before the last `forgetPictures` (tests) ends without freeing one of the new ones. */
let generation = 0;

function hold(entry: Kept): HeldPicture {
  entry.shown++;
  let released = false;
  return {
    url: entry.url,
    blob: entry.blob,
    release: () => {
      if (released) return;
      released = true;
      entry.shown--;
      if (entry.shown === 0 && entry.dropped) URL.revokeObjectURL(entry.url);
      trim();
    },
  };
}

/** Gives back the addresses of the oldest pictures nothing shows, past the run's allowance. */
function trim() {
  let bytes = 0;
  for (const entry of kept.values()) bytes += entry.blob.size;
  for (const [id, entry] of kept) {
    if (kept.size <= KEPT && bytes <= KEPT_BYTES) return;
    if (entry.shown > 0) continue;
    kept.delete(id);
    bytes -= entry.blob.size;
    URL.revokeObjectURL(entry.url);
  }
}

function turn(): Promise<void> {
  if (reading < READING) { reading++; return Promise.resolve(); }
  return new Promise((resolve) => turns.push(resolve));
}

function done(given: number) {
  if (given !== generation) return;
  const next = turns.shift();
  if (next) next();
  else reading--;
}

/**
 * File `id`'s picture, held for the caller: from this run's kept ones, else read with `read` once a turn comes. Null
 * when there is nothing to show, or when `signal` was aborted (the bubble left the screen or went) before its turn:
 * then nothing is read. Never rejects.
 */
export async function readPicture(id: string, read: () => Promise<Blob | null>, signal: AbortSignal): Promise<HeldPicture | null> {
  const known = kept.get(id);
  if (known) {
    kept.delete(id);
    kept.set(id, known);
    return hold(known);
  }
  const given = generation;
  await turn();
  try {
    if (signal.aborted) return null;
    // Read for another bubble of the same file while this one waited.
    const meanwhile = kept.get(id);
    if (meanwhile) return hold(meanwhile);
    const blob = await read().catch(() => null);
    if (!blob) return null;
    const entry: Kept = { url: URL.createObjectURL(blob), blob, shown: 0, dropped: false };
    kept.set(id, entry);
    const held = hold(entry);
    trim();
    return held;
  } finally {
    done(given);
  }
}

/** Forgets file `id`'s picture: what was read was a part of the file (it is arriving again). */
export function forgetPicture(id: string): void {
  const entry = kept.get(id);
  if (!entry) return;
  kept.delete(id);
  entry.dropped = true;
  if (entry.shown === 0) URL.revokeObjectURL(entry.url);
}

/** Forgets every picture read (tests). */
export function forgetPictures(): void {
  kept.clear();
  generation++;
  reading = 0;
  turns.length = 0;
}
