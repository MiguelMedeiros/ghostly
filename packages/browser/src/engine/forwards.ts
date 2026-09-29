import { FileAppender, storedSize } from "../shared/storedFiles";
import { SMALL_FILE_BYTES, fileBytes, fileBytesOf } from "../shared/fileBytes";
import { fileStore, type StoredFile } from "../shared/idb";
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
export interface ForwardResult { to: string; messageIds: string[]; error: string | null }

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

/** How many bytes of a stored file are actually here: all of them once it arrived. */
async function bytesHere(file: StoredFile): Promise<number> {
  if (file.blob) return file.blob.size;
  const bytes = file.bytes ? await fileBytesOf(file.bytes) : null;
  return (await bytes?.size(file.id)) ?? 0;
}

/**
 * A copy of a file on this device, for sending in another chat under `file.id`: a small one whole, a larger one a
 * step at a time, never whole in memory. Refused while it is still arriving, or when its bytes are gone.
 */
export async function copyForForward(sourceId: string, target: { linkId: string; wireId: string; timestamp: number; file: MessageFile }): Promise<void> {
  const source = await fileStore.get(sourceId);
  if (!source?.metadata) throw new Error("The file is not on this device any more");
  const size = storedSize(source);
  // One arriving with files/3 is whole only once its digest checked out; any other is whole when all its bytes are here.
  if (source.direction === "in" && source.wire3 && source.wire3.state !== "done" || await bytesHere(source) !== size)
    throw new Error("The file has not arrived yet");
  const { file, linkId, wireId, timestamp } = target;
  const metadata = { name: file.name, size: file.size, mime: file.mime, timestamp, voice: file.voice, video: file.video, image: file.image };
  const record = { id: file.id, linkId, createdAt: timestamp, direction: "out" as const, wireId, metadata, transfer: { state: "transferring" as const, transferred: 0, size: file.size } };
  if (size <= SMALL_FILE_BYTES && source.blob) {
    // Its bytes in a Blob of its own: WebKit keeps a stored Blob as one file, and a slice of the original would share it,
    // gone for both once either record is deleted (see `fileStore`).
    const copy = new Blob([await source.blob.slice(0, size).arrayBuffer()], { type: source.blob.type });
    await fileStore.put({ ...record, blob: copy, ...(source.digest && { digest: source.digest }) });
    return;
  }
  const bytes = await fileBytes();
  const from = source.bytes ? await fileBytesOf(source.bytes) : null;
  try {
    const appender = new FileAppender(bytes, file.id);
    for (let offset = 0; offset < size;) {
      const part = source.blob ? new Uint8Array(await source.blob.slice(offset, offset + 1024 * 1024).arrayBuffer()) : await from!.read(source.id, offset, Math.min(1024 * 1024, size - offset));
      if (!part.length) throw new Error("The file is shorter than it says");
      await appender.append(part);
      offset += part.length;
    }
    await appender.close();
    // The same bytes, so the same digest: read back only when the original never had one written down.
    const digest = source.digest ?? await bytes.digest(file.id);
    await fileStore.put({ ...record, bytes: bytes.kind, digest });
  } catch (error) {
    await bytes.remove(file.id).catch(() => {});
    throw error;
  }
}
