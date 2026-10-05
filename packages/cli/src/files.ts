import { openAsBlob } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { LIMITS, PLAYABLE_AUDIO, VOICE_LIMITS, baseMime, parseVoiceMeta, randomBytes, readImageMeta, sanitizeFileName, sanitizeMime, toBase64Url } from "@ghostly/core";
import { FILE_BYTES_STEP, fileBytes, fileBytesOf } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import { removeStored } from "@ghostly/browser/shared/storedFiles";
import { replyRef } from "@ghostly/browser/shared/replies";
import type { LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { bool, chatOf, list, node, num, oneOf, state, str, waitForState, type ApiContext, type Method, type Params } from "./apiKit";
import { CliError } from "./errors";
import { endTyping } from "./typing";
import { measureVoice } from "./voicePeaks";

/**
 * Files and voice notes in a chat (WISP 1100, phase 3), as the app's composer sends them (packages/browser
 * platform/services.ts `sendFile`): the bytes go into the profile's file store first, then the engine offers them.
 * Large files follow files/3: the receiving side's person (here, a command) accepts or declines each offer.
 */

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv",
  ".zip": "application/zip", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
  ".webm": "audio/webm", ".mp4": "video/mp4", ".mov": "video/quicktime",
};

export function mimeOf(path: string, given?: string): string {
  return sanitizeMime(given ?? TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
}

/** A chat's files as the timeline shows them, with where each transfer stands. */
export function filesOf(messages: { id: string; file?: MessageFile; sender: string; timestamp: number }[], transfers: Record<string, unknown>) {
  return messages.filter((m) => m.file).map((m) => ({
    messageId: m.id, from: m.sender, timestamp: m.timestamp,
    file: { id: m.file!.id, name: m.file!.name, size: m.file!.size, mime: m.file!.mime, ...(m.file!.voice ? { voice: m.file!.voice } : {}), ...(m.file!.image ? { image: m.file!.image } : {}) },
    transfer: transfers[m.file!.id] ?? null,
  }));
}

/**
 * The chat a file belongs to: a file id starts with its chat's id, so the chat may be left out; given, it must be
 * the file's own.
 */
function fileChat(ctx: ApiContext, params: Params, fileId: string): LinkView {
  const link = params.chat === undefined
    ? state(ctx).links.find((l) => fileId.startsWith(`${l.id}-in-`) || fileId.startsWith(`${l.id}-out-`))
    : chatOf(ctx, params);
  if (!link) throw new CliError("not_found", `No file ${fileId}`);
  if (!fileId.startsWith(`${link.id}-`)) throw new CliError("not_found", `No file ${fileId} in this chat`);
  return link;
}

const VOICE_ONLY = "A voice note is audio (webm, ogg, mp4, mpeg, aac, m4a or wav) of at most 15 minutes, with peaks from 0 to 255";

const ACTIONS = ["accept", "decline", "pause", "resume", "cancel", "resend", "request"] as const;

export const FILE_METHODS: Record<string, Method> = {
  async "file.send"(ctx, params) {
    const link = chatOf(ctx, params);
    const path = resolve(str(params, "path", true));
    let info;
    try { info = await stat(path); } catch { throw new CliError("not_found", `No file ${path}`); }
    if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file`);
    if (link.profile && link.dataLink === "open" && !link.capabilities?.files) throw new CliError("unavailable", "The contact's app takes no files");
    if (!link.capabilities?.largeFiles && info.size > LIMITS.maxFileBytes) throw new CliError("refused", `Too large for the contact's app (at most ${LIMITS.maxFileBytes} bytes)`);
    if (typeof link.peerFileRoom === "number" && info.size > link.peerFileRoom) throw new CliError("refused", `Not enough space on the contact's device (${link.peerFileRoom} bytes free)`);
    const mime = mimeOf(path, str(params, "mime"));
    // A reply names a message of this chat, as `send --reply` does: checked before anything is stored.
    const replyTo = str(params, "reply");
    if (replyTo) {
      const messages = await node(ctx).getMessages(link.id);
      if (!messages.some((m) => m.id === replyTo || replyRef(m) === replyTo)) throw new CliError("not_found", "That message is not in this chat, or cannot be replied to");
    }
    let voice, warning: string | undefined;
    if (params.voice !== undefined) {
      if (!PLAYABLE_AUDIO.test(baseMime(mime))) throw new CliError("bad_request", VOICE_ONLY);
      // Without a length or a waveform, both are measured from the sound, as the apps measure their recordings.
      let duration = params.voice === true ? undefined : num(params, "voice", 0, { min: 1 });
      let peaks = list(params, "peaks").map(Number);
      if (duration === undefined || !peaks.length) {
        const measured = await measureVoice(path);
        if ("voice" in measured) {
          duration ??= measured.voice.duration;
          if (!peaks.length) peaks = measured.voice.peaks;
        } else if (duration === undefined) {
          throw new CliError("bad_request", `Could not measure the voice note (${measured.problem}): give its length as --voice <ms>`);
        } else warning = `Sent without a waveform: could not read the sound (${measured.problem})`;
      }
      voice = parseVoiceMeta({ duration, peaks: peaks.length ? peaks : new Array(VOICE_LIMITS.bars).fill(0) }, mime);
      if (!voice) throw new CliError("bad_request", VOICE_ONLY);
    }
    const source = await openAsBlob(path, { type: mime });
    // A picture goes with its size, read from its first bytes as the apps read it (PNG, JPEG, GIF, WebP).
    const image = voice ? undefined : await readImageMeta(source, mime);
    const wireId = toBase64Url(randomBytes(12));
    const file: MessageFile = { id: `${link.id}-out-${wireId}`, name: sanitizeFileName(str(params, "name") ?? basename(path)), size: info.size, mime, ...(voice ? { voice } : {}), ...(image ? { image } : {}) };
    const timestamp = Date.now();
    const bytes = await fileBytes();
    const digest = await bytes.stage(file.id, source);
    await fileStore.put({
      id: file.id, linkId: link.id, bytes: bytes.kind, digest, createdAt: timestamp, direction: "out", wireId,
      metadata: { name: file.name, size: file.size, mime: file.mime, timestamp, ...(voice ? { voice } : {}), ...(image ? { image } : {}) },
      transfer: { state: "transferring", transferred: 0, size: file.size },
    });
    endTyping(ctx, { linkId: link.id }, true);
    try {
      await node(ctx).sendFile({ linkId: link.id, file, timestamp, ...(replyTo ? { replyTo } : {}) });
    } catch (error) {
      // Refused before it started (offline, a stopped chat, a contact whose app takes no files): nothing is in the chat,
      // so the staged copy goes too.
      await removeStored(file.id).catch(() => {});
      throw new CliError("refused", error instanceof Error ? error.message : String(error));
    }
    return { chat: link.id, file: { id: file.id, name: file.name, size: file.size, mime: file.mime, ...(voice ? { voice: true } : {}), ...(image ? { image } : {}) }, ...(warning ? { warning } : {}) };
  },

  async "file.list"(ctx, params) {
    const link = chatOf(ctx, params);
    return { chat: link.id, files: filesOf(await node(ctx).getMessages(link.id), state(ctx).transfers) };
  },

  /**
   * files/3: answer an offer, or pause, resume or cancel a transfer, either way; `resend` a file sent from here that
   * stopped moving (or failed), `request` again one that stopped arriving. Without a chat, the file's id names it.
   */
  async "file.action"(ctx, params) {
    const fileId = str(params, "file", true);
    const link = fileChat(ctx, params, fileId);
    const action = oneOf(params, "action", ACTIONS, "accept");
    if (action === "resend" || action === "request") {
      const outgoing = fileId.startsWith(`${link.id}-out-`);
      if (outgoing !== (action === "resend")) throw new CliError("bad_request", outgoing ? "A file sent from here is sent again: file resend" : "A received file is asked for again: file request");
      const transfer = state(ctx).transfers[fileId];
      if (!transfer || transfer.state === "done") throw new CliError("refused", outgoing ? "Nothing to send again: it arrived whole" : "Nothing to ask for: the file is all here");
      if (transfer.state === "failed" && (!outgoing || !transfer.retry)) throw new CliError("refused", `It ended: ${transfer.error ?? "failed"}`);
    }
    await node(ctx).fileAction({ linkId: link.id, fileId, action });
    return { chat: link.id, file: fileId, action, transfer: state(ctx).transfers[fileId] ?? null };
  },

  /**
   * Until a transfer ends: done answers, failed is an `engine` error with the transfer's words (and whether `file
   * resend` can go on). A file whose transfer this run has not seen answers from the file store.
   */
  async "file.wait"(ctx, params) {
    const fileId = str(params, "file", true);
    const link = fileChat(ctx, params, fileId);
    const stored = await fileStore.get(fileId);
    if (!stored && !state(ctx).transfers[fileId]) throw new CliError("not_found", `No file ${fileId}`);
    const ms = num(params, "timeout", 300, { min: 1, max: 86_400 }) * 1000;
    const transfer = await waitForState(ctx, (s) => {
      const now = s.transfers[fileId] ?? stored?.transfer;
      return now && (now.state === "done" || now.state === "failed") ? now : undefined;
    }, ms, `file ${fileId} to arrive`).catch((error: unknown) => {
      const now = state(ctx).transfers[fileId];
      if (error instanceof CliError && error.code === "timeout" && now) throw new CliError("timeout", `${error.message} (${now.transferred} of ${now.size} bytes${now.stage ? `, ${now.stage}` : ""})`, { file: fileId, transferred: now.transferred, size: now.size, stage: now.stage ?? null });
      throw error;
    });
    if (transfer.state === "failed") throw new CliError("engine", transfer.error ?? "The transfer failed", { file: fileId, chat: link.id, retry: !!transfer.retry });
    return { chat: link.id, file: fileId, state: "done", size: transfer.size };
  },

  /** Writes a received (or sent) file to disk: into `dir` under its own name, or to `path`. Never over a file unless `force`. */
  async "file.save"(ctx, params) {
    const fileId = str(params, "file", true);
    if (params.chat !== undefined) fileChat(ctx, params, fileId);
    if (bool(params, "wait")) await FILE_METHODS["file.wait"](ctx, { file: fileId, timeout: params.timeout });
    const stored = await fileStore.get(fileId);
    if (!stored?.metadata) throw new CliError("not_found", `No file ${fileId}`);
    if (stored.leftOut) throw new CliError("not_found", "Not in this backup: the light backup this profile was restored from left the file out");
    const transfer = state(ctx).transfers[fileId] ?? stored.transfer;
    if (transfer && transfer.state !== "done") throw new CliError("unavailable", `The file is not all here yet (${transfer.transferred} of ${transfer.size} bytes)`);
    const target = str(params, "path") ? resolve(str(params, "path", true)) : join(resolve(str(params, "dir") ?? "."), sanitizeFileName(stored.metadata.name));
    const flags = bool(params, "force") ? "w" : "wx";
    let out;
    try { out = await open(target, flags, 0o600); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError("confirm", `${target} exists: pass force (--force) to replace it`);
      throw error;
    }
    let written = 0, complete = false;
    try {
      const backend = stored.bytes ? await fileBytesOf(stored.bytes) : null;
      if (backend) {
        const size = await backend.size(fileId);
        if (size === null) throw new CliError("not_found", "The file's bytes are not on this device");
        for (let offset = 0; offset < size; offset += FILE_BYTES_STEP) {
          const chunk = await backend.read(fileId, offset, FILE_BYTES_STEP);
          await out.write(chunk);
          written += chunk.length;
        }
      } else if (stored.blob) {
        const chunk = new Uint8Array(await stored.blob.arrayBuffer());
        await out.write(chunk);
        written = chunk.length;
      } else throw new CliError("not_found", "The file's bytes are not on this device");
      complete = true;
    } finally {
      await out.close();
      if (!complete) await rm(target, { force: true });
    }
    return { file: fileId, path: target, size: written, name: stored.metadata.name, mime: stored.metadata.mime };
  },
};
