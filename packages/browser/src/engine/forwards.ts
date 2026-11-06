import { NO_PICTURE_METADATA, PICTURE_METADATA_LIMITS, audioMetadataPatches, isStrippedPicture, stripPictureMetadata, videoMetadataPatches, withoutAudioMetadata, withoutVideoMetadata, type VideoPatch } from "@ghostly/core";
import { FileAppender, storedSize } from "../shared/storedFiles";
import { SMALL_FILE_BYTES, blobDigest, fileBytes, fileBytesOf } from "../shared/fileBytes";
import { errorLine, fileStore, type StoredFile } from "../shared/idb";
import type { MessageFile, StoredMessage } from "../shared/types";

/*
 * Forwarding (WISP 400 § Forwards): messages of one chat sent on to others, each as a new message of mine that says
 * only how many times it has been forwarded. A text goes as it was written (its Markdown source, its link preview); a
 * file goes from the bytes already on this device, copied for the new chat, never fetched again.
 */

/** At most this many chats at once, as WhatsApp does: forwarding is for a few people, not a broadcast. */
export const FORWARD_TARGETS = 5;
/** At most this many messages at once. */
export const FORWARD_MESSAGES = 30;

/** What each chat forwarded to got: the new messages' ids, in order, and the first problem, if any. */
/**
 * What one chat or group got of a forward: the new messages (`messageIds`), the forwarded ones they came from
 * (`sent`, their ids in the chat forwarded from) and the first problem. A chat that got part of it is sent only the
 * rest the next time (agents#1082).
 */
export interface ForwardResult { to: string; messageIds: string[]; sent: string[]; error: string | null }

/**
 * Whether a message can be forwarded, and as what. Payments and payment requests (a bearer token or a request is for
 * the chat it was made in), a group's history lines and its payment notes cannot; neither can a message with nothing
 * in it. Identity shares and call lines are not messages here at all.
 */
export function forwardKind(message: StoredMessage): "text" | "file" | { refused: string } {
  if (message.sender !== "me" && message.sender !== "peer") return { refused: "This message cannot be forwarded" };
  if (message.paymentId) return { refused: "Payments and payment requests cannot be forwarded" };
  if (message.event || message.groupPay) return { refused: "This line cannot be forwarded" };
  if (message.file) return "file";
  return message.text.trim() ? "text" : { refused: "This message cannot be forwarded" };
}

/**
 * Why a chat did not get a forward, as its result says it: never "" (a result with an error is a failure, whatever it
 * says). A copy that found no room says so in the words the app knows however the storage put it: IndexedDB's
 * QuotaExceededError (an empty message in Chromium), the OPFS worker's (named so), Desktop's io error (the system's English).
 */
export function forwardError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  if (/^No space left on device\b/.test(message)) return `Not enough space on this device (${message})`;
  const name = (error as { name?: unknown } | null)?.name;
  return errorLine(error).trim() || (typeof name === "string" && name ? name : "Error");
}

/** How many bytes of a stored file are actually here: all of them once it arrived. */
async function bytesHere(file: StoredFile): Promise<number> {
  if (file.blob) return file.blob.size;
  const bytes = file.bytes ? await fileBytesOf(file.bytes) : null;
  return (await bytes?.size(file.id)) ?? 0;
}

type Read = (offset: number, length: number) => Promise<Uint8Array>;

/** `read` with the parts `patches` replace (zeros where a patch has no bytes). */
function patchedRead(read: Read, patches: VideoPatch[]): Read {
  return async (offset, length) => {
    const part = (await read(offset, length)).slice();
    const end = offset + part.length;
    for (const { start, end: until, bytes } of patches) {
      if (until <= offset || start >= end) continue;
      const from = Math.max(start, offset), to = Math.min(until, end);
      if (bytes) part.set(bytes.subarray(from - start, to - start), from - offset);
      else part.fill(0, from - offset, to - offset);
    }
    return part;
  };
}

/**
 * A received picture, video, audio file or voice note as it goes on: without its metadata (one from an app that sent
 * it with them keeps where its author took it, the device, the time, an audio file's tags), as one sent from here;
 * undefined for any other file, copied as it is. A picture is read whole; a video's or an audio file's stripped bytes
 * are a Blob when it is kept in one, else read through the parts changed. Refused with `NO_PICTURE_METADATA`,
 * `NO_VIDEO_METADATA` or `NO_AUDIO_METADATA` when its metadata cannot be removed.
 */
async function withoutMetadata(source: StoredFile, size: number, file: MessageFile, read: Read): Promise<Blob | Read | undefined> {
  if (!size) return undefined;
  if (file.video || file.voice || !isStrippedPicture(await read(0, Math.min(PICTURE_METADATA_LIMITS.headBytes, size)), file.mime)) {
    if (source.blob) return await withoutVideoMetadata(source.blob, file.mime) ?? await withoutAudioMetadata(source.blob, file.mime);
    // A whole box at a time: a storage's read can return fewer bytes than asked before the end.
    const readFully: Read = async (offset, length) => {
      const whole = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      for (let at = 0; at < whole.length;) {
        const part = await read(offset + at, whole.length - at);
        if (!part.length) break;
        whole.set(part, at);
        at += part.length;
      }
      return whole;
    };
    const patches = await videoMetadataPatches({ size, read: readFully }, file.mime) ?? await audioMetadataPatches({ size, read: readFully }, file.mime);
    return patches && patchedRead(read, patches);
  }
  if (size > PICTURE_METADATA_LIMITS.maxBytes) throw new Error(NO_PICTURE_METADATA);
  const whole = new Uint8Array(size);
  for (let offset = 0; offset < size;) {
    const part = await read(offset, Math.min(1024 * 1024, size - offset));
    if (!part.length) throw new Error("The file is shorter than it says");
    whole.set(part, offset);
    offset += part.length;
  }
  return new Blob(stripPictureMetadata(whole, file.mime) as BlobPart[], { type: source.blob?.type ?? file.mime });
}

/** What a forward of a message deleted meanwhile says, whether it went before the forward or while its file was copied. */
export const FORWARD_MESSAGE_GONE = "That message is not in this chat";

type ForwardTarget = { linkId: string; wireId: string; timestamp: number; file: MessageFile };

/**
 * A copy of a file on this device, for sending in another chat under `file.id`: a small one whole, a larger one a
 * step at a time, never whole in memory; a picture without its metadata, read whole, and a video or an audio file
 * without its. Refused while it is still arriving, or when its bytes are gone. Resolves to `file` as it goes: a
 * stripped file's size is its copy's.
 *
 * A copy cut off because its source went meanwhile says why, as one started after would: its message deleted (here, or
 * for everyone by its sender, which takes its file: `messageGone`, asked only once the copy failed) is
 * `FORWARD_MESSAGE_GONE`, its record gone with the message still here is "not on this device any more". Only bytes
 * missing from a source still kept whole on record stay "shorter than it says".
 *
 * `digests`, one per forward: a stripped copy's digest by its source's id. Its bytes are the same for every chat of the
 * forward (they depend only on the source and its type), so only the first copy is read back to be hashed.
 */
export async function copyForForward(sourceId: string, target: ForwardTarget, messageGone?: () => Promise<boolean>, digests?: Map<string, string>): Promise<MessageFile> {
  try {
    return await copyFile(sourceId, target, digests);
  } catch (error) {
    if (await messageGone?.().catch(() => false)) throw Object.assign(new Error(FORWARD_MESSAGE_GONE), { cause: error });
    if (!(await fileStore.get(sourceId).catch(() => ({ metadata: true })))?.metadata) throw Object.assign(new Error("The file is not on this device any more"), { cause: error });
    throw error;
  }
}

async function copyFile(sourceId: string, target: ForwardTarget, digests?: Map<string, string>): Promise<MessageFile> {
  const source = await fileStore.get(sourceId);
  if (!source?.metadata) throw new Error("The file is not on this device any more");
  const stored = storedSize(source);
  // One arriving with files/3, or a group's, is whole only once its digest checked out (a group's desk says so once it
  // did: a holder can leave bytes of the whole size that are not the author's); any other is whole when all its bytes are here.
  const checked = source.wire3 ? source.wire3.state === "done" : !source.group || source.transfer?.state === "done";
  if (source.direction === "in" && !checked || await bytesHere(source) !== stored)
    throw new Error("The file has not arrived yet");
  const from = source.bytes ? await fileBytesOf(source.bytes) : null;
  const read: Read = async (offset, length) => source.blob ? new Uint8Array(await source.blob.slice(offset, offset + length).arrayBuffer()) : from!.read(source.id, offset, length);
  // The bytes it is copied from, and their digest: the stripped copy's, computed on what is sent, never the original's.
  const stripped = await withoutMetadata(source, stored, target.file, read);
  const blob = typeof stripped === "function" ? undefined : stripped ?? source.blob, size = blob && stripped ? blob.size : stored;
  const readCopy = typeof stripped === "function" ? stripped : read;
  const known = stripped ? digests?.get(sourceId) : source.digest;
  const { linkId, wireId, timestamp } = target, file = stripped ? { ...target.file, size } : target.file;
  const metadata = { name: file.name, size: file.size, mime: file.mime, timestamp, voice: file.voice, video: file.video, image: file.image };
  const record = { id: file.id, linkId, createdAt: timestamp, direction: "out" as const, wireId, metadata, transfer: { state: "transferring" as const, transferred: 0, size: file.size } };
  if (size <= SMALL_FILE_BYTES && blob) {
    // Its bytes in a Blob of its own: WebKit keeps a stored Blob as one file, and a slice of the original would share it,
    // gone for both once either record is deleted (see `fileStore`).
    const copy = new Blob([await blob.slice(0, size).arrayBuffer()], { type: blob.type });
    const digest = known ?? (stripped ? await blobDigest(copy) : undefined);
    if (stripped && digest) digests?.set(sourceId, digest);
    await fileStore.put({ ...record, blob: copy, ...(digest && { digest }) });
    return file;
  }
  const bytes = await fileBytes();
  try {
    const appender = new FileAppender(bytes, file.id);
    for (let offset = 0; offset < size;) {
      const part = blob ? new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()) : await readCopy(offset, Math.min(1024 * 1024, size - offset));
      if (!part.length) throw new Error("The file is shorter than it says");
      await appender.append(part);
      offset += part.length;
    }
    await appender.close();
    // The same bytes, so the same digest: read back only when the original never had one written down (or was stripped,
    // once per forward).
    const digest = known ?? await bytes.digest(file.id);
    if (stripped) digests?.set(sourceId, digest);
    await fileStore.put({ ...record, bytes: bytes.kind, digest });
    return file;
  } catch (error) {
    await bytes.remove(file.id).catch(() => {});
    throw error;
  }
}
