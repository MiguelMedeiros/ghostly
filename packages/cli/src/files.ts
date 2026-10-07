import { openAsBlob } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { GROUP_FILE_LIMITS, LIMITS, PLAYABLE_AUDIO, VOICE_LIMITS, baseMime, parseVoiceMeta, randomBytes, readImageMeta, sanitizeFileName, sanitizeMime, toBase64Url, type VoiceMeta } from "@ghostly/core";
import { FILE_BYTES_STEP, fileBytes, fileBytesOf } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import { removeStored } from "@ghostly/browser/shared/storedFiles";
import { replyRef } from "@ghostly/browser/shared/replies";
import type { GroupView, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { groupFileId, groupOfFile } from "@ghostly/browser/engine/groupFiles";
import { bool, chatOf, findGroup, list, node, num, oneOf, state, str, waitForState, type ApiContext, type Method, type Params } from "./apiKit";
import { groupSendRefused } from "./api";
import { CliError } from "./errors";
import { endTyping } from "./typing";
import { measureVoice } from "./voicePeaks";

/**
 * Files and voice notes in a chat (WISP 1100, phase 3), as the app's composer sends them (packages/browser
 * platform/services.ts `sendFile`): the bytes go into the profile's file store first, then the engine offers them.
 * Large files follow files/3: the receiving side's person (here, a command) accepts or declines each offer.
 *
 * In a group (WISP 503 · Group Files) the file is announced as a group message, and each member's app fetches the
 * bytes from whoever holds them: by itself up to the automatic limits, on `file accept` past them.
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
 * The chat a file command names, or else a group (`group:<id>`, or a group's id, prefix or name where no chat has it),
 * as `forward` reads them. A name that is neither says what a chat would.
 */
function chatOrGroupOf(ctx: ApiContext, params: Params): { link: LinkView } | { group: GroupView } {
  const ref = str(params, "chat", true);
  if (ref.startsWith("group:")) return { group: findGroup(state(ctx).groups, ref.slice("group:".length)) };
  try {
    return { link: chatOf(ctx, params) };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found") throw error;
    try { return { group: findGroup(state(ctx).groups, ref) }; } catch { throw error; }
  }
}

/**
 * The chat or group a file belongs to: a file id starts with its chat's id (a group's file with `group-<id>-`), so it
 * may be left out; given, it must be the file's own. `where` is what the answer names it by.
 */
function fileChat(ctx: ApiContext, params: Params, fileId: string): { linkId: string; where: { chat: string } | { group: string } } {
  const groupId = groupOfFile(fileId, state(ctx).groups.map((g) => g.id));
  if (groupId) {
    const named = params.chat === undefined ? undefined : chatOrGroupOf(ctx, params);
    if (named && !("group" in named && named.group.id === groupId)) throw new CliError("not_found", `No file ${fileId} in this ${"group" in named ? "group" : "chat"}`);
    return { linkId: `group:${groupId}`, where: { group: groupId } };
  }
  const link = params.chat === undefined
    ? state(ctx).links.find((l) => fileId.startsWith(`${l.id}-in-`) || fileId.startsWith(`${l.id}-out-`))
    : chatOf(ctx, params);
  if (!link) throw new CliError("not_found", `No file ${fileId}`);
  if (!fileId.startsWith(`${link.id}-`)) throw new CliError("not_found", `No file ${fileId} in this chat`);
  return { linkId: link.id, where: { chat: link.id } };
}

const VOICE_ONLY = "A voice note is audio (webm, ogg, mp4, mpeg, aac, m4a or wav) of at most 15 minutes, with peaks from 0 to 255";

/** `--voice [ms] [--peaks …]`: the voice description, its length and waveform measured from the sound when not given. */
async function voiceOf(params: Params, path: string, mime: string): Promise<{ voice?: VoiceMeta; warning?: string }> {
  if (params.voice === undefined) return {};
  if (!PLAYABLE_AUDIO.test(baseMime(mime))) throw new CliError("bad_request", VOICE_ONLY);
  // Without a length or a waveform, both are measured from the sound, as the apps measure their recordings.
  let duration = params.voice === true ? undefined : num(params, "voice", 0, { min: 1 });
  let peaks = list(params, "peaks").map(Number);
  let warning: string | undefined;
  if (duration === undefined || !peaks.length) {
    const measured = await measureVoice(path);
    if ("voice" in measured) {
      duration ??= measured.voice.duration;
      if (!peaks.length) peaks = measured.voice.peaks;
    } else if (duration === undefined) {
      throw new CliError("bad_request", `Could not measure the voice note (${measured.problem}): give its length as --voice <ms>`);
    } else warning = `Sent without a waveform: could not read the sound (${measured.problem})`;
  }
  const voice = parseVoiceMeta({ duration, peaks: peaks.length ? peaks : new Array(VOICE_LIMITS.bars).fill(0) }, mime);
  if (!voice) throw new CliError("bad_request", VOICE_ONLY);
  return { voice, ...(warning ? { warning } : {}) };
}

/**
 * A file announced in a group (WISP 503): its bytes staged under a group file id with their digest, as a chat's are, then
 * the announcement. This device is its first holder and serves the members who ask.
 */
async function sendToGroup(ctx: ApiContext, params: Params, group: GroupView, path: string, size: number) {
  if (size > GROUP_FILE_LIMITS.maxBytes) throw new CliError("refused", `Too large for a group (at most ${GROUP_FILE_LIMITS.maxBytes} bytes)`);
  if (!size) throw new CliError("refused", "An empty file cannot go to a group");
  const mime = mimeOf(path, str(params, "mime"));
  const replyTo = str(params, "reply");
  if (replyTo) {
    const messages = await node(ctx).groupMessages({ groupId: group.id });
    if (!messages.some((m) => m.id === replyTo || replyRef(m) === replyTo)) throw new CliError("not_found", "That message is not in this group, or cannot be replied to");
  }
  const { voice, warning } = await voiceOf(params, path, mime);
  const source = await openAsBlob(path, { type: mime });
  const image = voice ? undefined : await readImageMeta(source, mime);
  const fileId = groupFileId(group.id, "out");
  const file: MessageFile = { id: fileId, name: sanitizeFileName(str(params, "name") ?? basename(path)), size, mime, ...(voice ? { voice } : {}), ...(image ? { image } : {}) };
  const timestamp = Date.now();
  const bytes = await fileBytes();
  const digest = await bytes.stage(fileId, source);
  await fileStore.put({
    id: fileId, linkId: `group:${group.id}`, bytes: bytes.kind, digest, createdAt: timestamp, direction: "out",
    metadata: { name: file.name, size, mime, timestamp, ...(voice ? { voice } : {}), ...(image ? { image } : {}) },
    transfer: { state: "transferring", transferred: 0, size },
  });
  endTyping(ctx, { groupId: group.id }, false);
  const result = await node(ctx).sendGroupFile({ groupId: group.id, file, ...(replyTo ? { replyTo } : {}) });
  if (result.error) {
    // Not announced: nothing is in the group, so the staged copy goes too.
    await removeStored(fileId).catch(() => {});
    throw result.refused ? new CliError("refused", result.error) : groupSendRefused(result.error);
  }
  return { group: group.id, messageId: result.messageId ?? null, file: { id: fileId, name: file.name, size, mime, ...(voice ? { voice: true } : {}), ...(image ? { image } : {}) }, ...(warning ? { warning } : {}) };
}

const ACTIONS = ["accept", "decline", "pause", "resume", "cancel", "resend", "request"] as const;

export const FILE_METHODS: Record<string, Method> = {
  async "file.send"(ctx, params) {
    const target = chatOrGroupOf(ctx, params);
    const path = resolve(str(params, "path", true));
    let info;
    try { info = await stat(path); } catch { throw new CliError("not_found", `No file ${path}`); }
    if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file`);
    if ("group" in target) return sendToGroup(ctx, params, target.group, path, info.size);
    const { link } = target;
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
    const { voice, warning } = await voiceOf(params, path, mime);
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
    const target = chatOrGroupOf(ctx, params);
    if ("group" in target) return { group: target.group.id, files: filesOf(await node(ctx).groupMessages({ groupId: target.group.id }), state(ctx).transfers) };
    return { chat: target.link.id, files: filesOf(await node(ctx).getMessages(target.link.id), state(ctx).transfers) };
  },

  /**
   * files/3: answer an offer, or pause, resume or cancel a transfer, either way; `resend` a file sent from here that
   * stopped moving (or failed), `request` again one that stopped arriving. Without a chat, the file's id names it.
   * A group's file (WISP 503) takes `accept` (download one this device did not fetch by itself) and `request`.
   */
  async "file.action"(ctx, params) {
    const fileId = str(params, "file", true);
    const { linkId, where } = fileChat(ctx, params, fileId);
    const action = oneOf(params, "action", ACTIONS, "accept");
    if ("group" in where) {
      if (action !== "accept" && action !== "request") throw new CliError("bad_request", "A group's file is downloaded (file accept) or asked for again (file request)");
      if (state(ctx).transfers[fileId]?.state === "done") throw new CliError("refused", "Nothing to ask for: the file is all here");
      try { await node(ctx).fileAction({ linkId, fileId, action }); } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
      return { ...where, file: fileId, action, transfer: state(ctx).transfers[fileId] ?? null };
    }
    if (action === "resend" || action === "request") {
      const outgoing = fileId.startsWith(`${linkId}-out-`);
      if (outgoing !== (action === "resend")) throw new CliError("bad_request", outgoing ? "A file sent from here is sent again: file resend" : "A received file is asked for again: file request");
      const transfer = state(ctx).transfers[fileId];
      if (!transfer || transfer.state === "done") throw new CliError("refused", outgoing ? "Nothing to send again: it arrived whole" : "Nothing to ask for: the file is all here");
      if (transfer.state === "failed" && (!outgoing || !transfer.retry)) throw new CliError("refused", `It ended: ${transfer.error ?? "failed"}`);
    }
    await node(ctx).fileAction({ linkId, fileId, action });
    return { ...where, file: fileId, action, transfer: state(ctx).transfers[fileId] ?? null };
  },

  /**
   * Until a transfer ends: done answers, failed is an `engine` error with the transfer's words (and whether `file
   * resend` can go on). A file whose transfer this run has not seen answers from the file store.
   */
  async "file.wait"(ctx, params) {
    const fileId = str(params, "file", true);
    const { where } = fileChat(ctx, params, fileId);
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
    if (transfer.state === "failed") throw new CliError("engine", transfer.error ?? "The transfer failed", { file: fileId, ...where, retry: !!transfer.retry });
    return { ...where, file: fileId, state: "done", size: transfer.size };
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
