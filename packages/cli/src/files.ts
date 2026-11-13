import { execFile } from "node:child_process";
import { openAsBlob } from "node:fs";
import { access, constants, copyFile, link, open, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { GROUP_FILE_LIMITS, LIMITS, NO_PICTURE_METADATA, NO_AUDIO_METADATA, NO_VIDEO_METADATA, PLAYABLE_AUDIO, VOICE_LIMITS, baseMime, claimedTime, parseVoiceMeta, randomBytes, readImageMeta, sanitizeFileName, sanitizeMime, toBase64Url, voiceDownloadName, withoutAudioMetadata, withoutPictureMetadata, withoutVideoMetadata, type VoiceMeta } from "@ghostly/core";
import { FILE_BYTES_STEP, fileBytes, fileBytesOf } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import { removeStored, waitingGroupFile } from "@ghostly/browser/shared/storedFiles";
import { replyRef } from "@ghostly/browser/shared/replies";
import type { EngineState, FileTransferView, GroupView, MessageFile, StoredMessage } from "@ghostly/browser/shared/types";
import { groupFileId, groupOfFile } from "@ghostly/browser/engine/groupFiles";
import { childEnv } from "./childEnv";
import { bool, chatOf, findChatOrGroup, keptForJoin, list, noFile, noMessage, node, num, oneOf, oneShotWaits, sentAt, state, str, waitForState, type ApiContext, type Method, type Params } from "./apiKit";
import { groupSendRefused } from "./api";
import { CliError } from "./errors";
import { guardText } from "./secretGuard";
import { endTyping } from "./typing";
import { measureVoice } from "./voicePeaks";
import { goesOn } from "./waits";

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

/**
 * The time a saved voice message is named from: its message's in the chat, as the apps' Download names it. The file's
 * own time is what its sender says (any safe integer, past Date's end too), taken only when no message is there and
 * a date can hold it; else when it was stored here.
 */
async function voiceTime(ctx: ApiContext, stored: { id: string; linkId: string; createdAt: number; metadata?: { timestamp: number } }): Promise<number> {
  // Past the newest, among the history's file rows only (the messages store's file index): the whole history, read for
  // each old voice message saved, held the daemon 0.8 s at 100,000 messages.
  const older = (linkId: string) => node(ctx).fileMessages(linkId);
  return (await findMessage(ctx, stored.linkId, (m) => m.file?.id === stored.id, older))?.timestamp ?? claimedTime(stored.metadata?.timestamp) ?? stored.createdAt;
}

/**
 * The message of a chat or a group (`group:<id>`) that `test` picks: looked for among its newest first, where the one a
 * command names almost always is, then in all of them only when there are more. A whole history costs a read of every row;
 * `older` reads fewer, where the message is known to be among them.
 */
async function findMessage(ctx: ApiContext, linkId: string, test: (m: StoredMessage) => boolean, older?: (linkId: string) => Promise<StoredMessage[]>): Promise<StoredMessage | undefined> {
  const page = await node(ctx).messagePage({ linkId, limit: 200 });
  const newest = page.messages.find(test);
  if (newest || !page.more) return newest;
  if (older) return (await older(linkId)).find(test);
  const group = linkId.startsWith("group:") ? linkId.slice("group:".length) : undefined;
  return (group ? await node(ctx).groupMessages({ groupId: group }) : await node(ctx).getMessages(linkId)).find(test);
}

/** A chat's files as the timeline shows them, with where each transfer stands (`transferOf`, by file id). */
export function filesOf(messages: { id: string; file?: MessageFile; sender: string; timestamp: number }[], transferOf: (fileId: string) => unknown) {
  return messages.filter((m) => m.file).map((m) => ({
    messageId: m.id, from: m.sender, timestamp: m.timestamp,
    file: { id: m.file!.id, name: m.file!.name, size: m.file!.size, mime: m.file!.mime, ...(m.file!.voice ? { voice: m.file!.voice } : {}), ...(m.file!.image ? { image: m.file!.image } : {}) },
    transfer: transferOf(m.file!.id) ?? null,
  }));
}

/** A file's size as a person reads it: "40 MB", "26.2 MB". */
const megabytes = (size: number) => `${Math.round(size / 100_000) / 10} MB`;

/**
 * Where an unfinished transfer stands, in words, for a person reading a timeout: the stage's id ("asking", "waiting")
 * stays in `details.stage` for a bot. A group's file says why it waits (`note`), as the app does.
 */
function stageWords(transfer: FileTransferView): string {
  switch (transfer.stage) {
    case "preparing": return "getting it ready to send";
    case "waiting": return transfer.note ?? "waiting for a connection to the contact";
    case "asking": return transfer.direction === "in" ? "waiting for you to take it (file accept)" : "waiting for the contact to take it";
    case "queued": return "waiting its turn";
    case "paused": return transfer.pausedBy === "peer" ? "paused by the contact" : "paused here (file resume)";
    case "verifying": return "every byte here, checking it";
    default: return String(transfer.stage);
  }
}

/**
 * A transfer that waits for a person's decision (`asking`), with whose: `me` (`file accept` takes it here) or `contact`
 * (theirs). A received file's `transferring` alone read as if it were moving.
 */
function withWaitingFor(transfer: FileTransferView | undefined): (FileTransferView & { waitingFor?: "me" | "contact" }) | undefined {
  if (transfer?.state !== "transferring" || transfer.stage !== "asking") return transfer;
  return { ...transfer, waitingFor: transfer.direction === "in" ? "me" : "contact" };
}

/** The chat or the group a file command names (`findChatOrGroup`). */
const chatOrGroupOf = (ctx: ApiContext, params: Params, { links, groups }: EngineState = state(ctx)) => findChatOrGroup(links, groups, str(params, "chat", true));

/**
 * The chat or group a file belongs to: a file id starts with its chat's id (a group's file with `group-<id>-`), so it
 * may be left out; given, it must be the file's own. `where` is what the answer names it by.
 */
function fileChat(ctx: ApiContext, params: Params, fileId: string): { linkId: string; where: { chat: string } | { group: string } } {
  const s = state(ctx);
  const groupId = groupOfFile(fileId, s.groups.map((g) => g.id));
  if (groupId) {
    const named = params.chat === undefined ? undefined : chatOrGroupOf(ctx, params, s);
    if (named && !("group" in named && named.group.id === groupId)) throw noFile(fileId, { group: "group" in named, ref: str(params, "chat", true) });
    return { linkId: `group:${groupId}`, where: { group: groupId } };
  }
  const link = params.chat === undefined
    ? s.links.find((l) => fileId.startsWith(`${l.id}-in-`) || fileId.startsWith(`${l.id}-out-`))
    : chatOf(ctx, params, s);
  if (!link) throw noFile(fileId);
  if (!fileId.startsWith(`${link.id}-`)) throw noFile(fileId, { group: false, ref: str(params, "chat", true) });
  return { linkId: link.id, where: { chat: link.id } };
}

const VOICE_MINUTES = VOICE_LIMITS.maxDurationMs / 60_000;

/**
 * `--voice [ms] [--peaks …]`: the voice description, its length and waveform measured from the sound when not given.
 * A file that is not a voice note is refused naming what is wrong with it: empty, not audio, too long.
 */
async function voiceOf(params: Params, path: string, mime: string, size: number): Promise<{ voice?: VoiceMeta; warning?: string }> {
  if (params.voice === undefined) return {};
  const name = basename(path);
  if (!size) throw new CliError("bad_request", `${name} is empty: a voice note is audio`);
  if (!PLAYABLE_AUDIO.test(baseMime(mime))) throw new CliError("bad_request", `${name} is ${mime}, not audio (webm, ogg, mp4, mpeg, aac, m4a or wav)`);
  // Without a length or a waveform, both are measured from the sound, as the apps measure their recordings.
  const given = params.voice === true ? undefined : num(params, "voice", 0, { min: 1 });
  let duration = given;
  let peaks = list(params, "peaks").map(Number);
  let warning: string | undefined;
  if (duration === undefined || !peaks.length) {
    const measured = await measureVoice(path);
    if ("voice" in measured) {
      duration ??= measured.voice.duration;
      if (!peaks.length) peaks = measured.voice.peaks;
    } else if (measured.notSound) {
      // A length given for it would send a voice note that cannot play.
      throw new CliError("bad_request", `${name} is not audio (${measured.problem})`);
    } else if (duration === undefined) {
      throw new CliError("bad_request", `Could not measure the voice note (${measured.problem}): give its length as --voice <ms>`);
    } else warning = `Sent without a waveform: could not read the sound (${measured.problem})`;
  }
  const voice = parseVoiceMeta({ duration, peaks: peaks.length ? peaks : new Array(VOICE_LIMITS.bars).fill(0) }, mime);
  if (voice) return { voice, ...(warning ? { warning } : {}) };
  // A length past the limit (with the moment a recorder takes to stop), or else a waveform the voice note does not take.
  if (duration! > VOICE_LIMITS.maxDurationMs + 5_000) {
    throw new CliError("bad_request", given === undefined
      ? `${name} is longer than ${VOICE_MINUTES} minutes: a voice note is at most ${VOICE_MINUTES}`
      : `A voice note is at most ${VOICE_MINUTES} minutes (${VOICE_LIMITS.maxDurationMs} ms), not ${given} ms`);
  }
  throw new CliError("bad_request", `A voice note's waveform is 1 to ${VOICE_LIMITS.maxBars} peaks from 0 to 255`);
}

/**
 * The file at `path` as it is sent, as the apps send it (platform/services.ts `sendable`): a picture, an MP4 or
 * QuickTime video or an audio file without its metadata (where it was taken or recorded, the device, the time, an
 * audio file's tags), before its size is read and its digest computed. One whose metadata cannot be removed is
 * refused, never sent as it was. A voice note is a file made anywhere, so its tags go too.
 */
async function sendable(path: string, mime: string): Promise<Blob> {
  const source = await openAsBlob(path, { type: mime });
  try {
    return await withoutPictureMetadata(source, mime) ?? await withoutVideoMetadata(source, mime) ?? await withoutAudioMetadata(source, mime) ?? source;
  } catch (error) {
    if (error instanceof Error && [NO_PICTURE_METADATA, NO_VIDEO_METADATA, NO_AUDIO_METADATA].includes(error.message)) throw new CliError("refused", error.message);
    throw error;
  }
}

/**
 * A read of the file at `path` through the Blob `openAsBlob` gave it. Node refuses every read of that Blob once the file
 * changed on disk (it grew, shrank or was written again: a log still written to, a file being saved), with a bare
 * DOMException "The blob could not be read" that named neither the file nor why, as `engine`. Said with its path, as
 * `unavailable`: sent again once nothing writes to it, it goes, and nothing of this try was kept (`stage` removes its copy).
 */
async function whileUnchanged<T>(path: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error && typeof error === "object" && (error as { name?: unknown }).name === "NotReadableError") {
      throw new CliError("unavailable", `${path} changed while it was being sent: send it again once nothing is writing to it`, { reason: "file_changed", path });
    }
    throw error;
  }
}

/**
 * A file announced in a group (WISP 503): its bytes staged under a group file id with their digest, as a chat's are, then
 * the announcement. This device is its first holder and serves the members who ask.
 */
async function sendToGroup(ctx: ApiContext, params: Params, group: GroupView, path: string, name: string, picked: number) {
  if (picked > GROUP_FILE_LIMITS.maxBytes) throw new CliError("refused", `Too large for a group (at most ${GROUP_FILE_LIMITS.maxBytes} bytes)`);
  if (!picked) throw new CliError("refused", "An empty file cannot go to a group");
  const mime = mimeOf(path, str(params, "mime"));
  const replyTo = str(params, "reply");
  if (replyTo) {
    if (!await findMessage(ctx, `group:${group.id}`, (m) => m.id === replyTo || replyRef(m) === replyTo)) throw noMessage(replyTo, { group: true, ref: str(params, "chat", true) }, { tail: ", or it cannot be replied to" });
  }
  // A send the group would refuse anyway (its files of the minute are taken, or this device is not in it) is refused
  // before a byte is copied in: a retry loop writes nothing. The announcement checks again.
  const check = await node(ctx).groupFileCheck({ groupId: group.id });
  if (check.error) throw check.refused ? new CliError("refused", check.error) : groupSendRefused(check.error);
  const { voice, warning } = await voiceOf(params, path, mime, picked);
  const source = await whileUnchanged(path, () => sendable(path, mime));
  const size = source.size;
  const image = voice ? undefined : await whileUnchanged(path, () => readImageMeta(source, mime));
  const fileId = groupFileId(group.id, "out");
  const file: MessageFile = { id: fileId, name, size, mime, ...(voice ? { voice } : {}), ...(image ? { image } : {}) };
  const timestamp = Date.now();
  const bytes = await fileBytes();
  const digest = await whileUnchanged(path, () => bytes.stage(fileId, source));
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

/** Bytes a file system takes in one name: 255 on ext4, btrfs, APFS (NTFS counts 255 UTF-16 units, within this too). */
const NAME_BYTES = 255;

/**
 * `name` as an entry of a folder: an app's name may have 200 characters, which in UTF-8 can be 800 bytes. The end of
 * its stem goes until it fits, its extension stays (as `sanitizeFileName` shortens it), so "文…文.txt" is saved as a text.
 */
export function fitName(name: string): string {
  const fits = (candidate: string) => Buffer.byteLength(candidate) <= NAME_BYTES;
  if (fits(name)) return name;
  const extension = /\.[^.\s]{1,15}$/u.exec(name)?.[0] ?? "";
  const stem = [...name.slice(0, name.length - extension.length)];
  while (stem.length && !fits(stem.join("").trimEnd() + extension)) stem.pop();
  return (stem.join("").trimEnd() || "file") + extension;
}

/**
 * The name `file save --dir` writes a file under. Its sender chose it, and the folder is one scripts and people run
 * tools in: a name that starts with a dash is an option to the tool a `*` hands it to ("-rf", "--checkpoint-action=…"),
 * so it gets a `_` first, as a Windows device name does in `sanitizeFileName`.
 */
export function saveName(name: string): string {
  const clean = sanitizeFileName(name);
  return fitName(clean.startsWith("-") ? `_${clean}` : clean);
}

/**
 * Gives the whole file at `partial` the name `target`: over a file there when `force`, else never (EEXIST). Where the
 * file system has no hard links (exFAT, some network shares), it is copied under the name, still never over a file.
 */
async function place(partial: string, target: string, force: boolean): Promise<void> {
  if (force) return rename(partial, target);
  try { await link(partial, target); } catch (error) {
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await copyFile(partial, target, constants.COPYFILE_EXCL);
  }
}

/**
 * Marks a saved copy of a contact's file as downloaded, as a browser and Ghostly Desktop (`file_store.rs`
 * `mark_downloaded`) do, so the system checks it when it is opened: Gatekeeper's "downloaded from the internet" on
 * macOS, SmartScreen and Office's Protected View on Windows. Node has no extended attributes, so macOS's own `xattr`
 * writes `com.apple.quarantine`; on Windows it is the file's `Zone.Identifier` stream. Best effort: a file system that
 * cannot hold the mark still gets the file.
 */
async function markDownloaded(path: string): Promise<void> {
  if (process.platform === "darwin") {
    // Flags 0x0001 (downloaded) and 0x0080, as browsers write them; then time and agent.
    const value = `0081;${Math.floor(Date.now() / 1000).toString(16).padStart(8, "0")};Ghostly;`;
    await new Promise<void>((done) => execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, path], { timeout: 10_000, env: childEnv() }, () => done()));
  } else if (process.platform === "win32") {
    await writeFile(`${path}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n").catch(() => {});
  }
}

const ACTIONS = ["accept", "decline", "pause", "resume", "cancel", "resend", "request"] as const;

/**
 * `file wait`: until a transfer ends: done answers, failed is an `engine` error with the transfer's words (and whether
 * `file resend` can go on). A file whose transfer this run has not seen answers from the file store. `stopping`: the
 * daemon's stop ends it as well (`waitForState`), for `file send --wait`, which answers with what it knows then.
 */
async function waitForFile(ctx: ApiContext, params: Params, stopping?: AbortSignal) {
  const fileId = str(params, "file", true);
  const { where } = fileChat(ctx, params, fileId);
  const stored = await fileStore.get(fileId);
  if (!stored && !state(ctx).transfers[fileId]) throw noFile(fileId);
  const ms = num(params, "timeout", 300, { min: 1, max: 86_400 }) * 1000;
  // A received file that waits for this person's `file accept` (over 25 MiB, or a group's file that did not come by
  // itself) does not move however long this waits: said at once, naming the command. Before, it waited out its
  // timeout and answered "0 of 40000000 bytes, asking", as if the contact were slow.
  const transfer = await waitForState(ctx, (s) => {
    const now = s.transfers[fileId] ?? stored?.transfer;
    return now && (now.state === "done" || now.state === "failed" || (now.stage === "asking" && now.direction === "in")) ? now : undefined;
  }, ms, `file ${fileId} to arrive`, stopping).catch((error: unknown) => {
    const now = state(ctx).transfers[fileId];
    if (error instanceof CliError && error.code === "timeout" && now) throw new CliError("timeout", `${error.message} (${now.transferred} of ${now.size} bytes${now.stage ? `, ${stageWords(now)}` : ""})`, { file: fileId, transferred: now.transferred, size: now.size, stage: now.stage ?? null, ...(error.details?.reason ? { reason: error.details.reason } : {}) });
    throw error;
  });
  if (transfer.state === "failed") throw new CliError("engine", transfer.error ?? "The transfer failed", { file: fileId, ...where, retry: !!transfer.retry });
  if (transfer.state !== "done") throw waitsForYou((stored ?? await fileStore.get(fileId).catch(() => undefined))?.metadata?.name, fileId, where, transfer.size);
  return { ...where, file: fileId, state: "done", size: transfer.size };
}

/** A received file that waits for this person's `file accept` (`file wait`, `file save`): said naming the command. */
function waitsForYou(name: string | undefined, fileId: string, where: { chat: string } | { group: string } | undefined, size: number): CliError {
  return new CliError("confirm", `${name ?? "The file"} (${megabytes(size)}) waits for you to take it: ghostly file accept ${fileId} (or file decline)`, { file: fileId, ...where, size, stage: "asking" });
}

export const FILE_METHODS: Record<string, Method> = {
  async "file.send"(ctx, params) {
    const path = resolve(str(params, "path", true));
    // The contact (or every member) reads its name as a message's text (docs/CLI.md § Safety): the name that goes out,
    // the file's own without --name, read once cleaned (a key split by a `:` or a line break the cleaning drops is whole).
    const name = sanitizeFileName(str(params, "name") ?? basename(path));
    guardText(name, bool(params, "force"), "file's name", "send it");
    const target = chatOrGroupOf(ctx, params);
    let info;
    try { info = await stat(path); } catch { throw new CliError("not_found", `No file ${path}`); }
    if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file`);
    // A file this user may not read: refused with its path (errors.ts), not the engine's "The blob could not be read" later.
    await access(path, constants.R_OK);
    // A one-shot leaves once its command is done, and the transfer with it: in a chat it stays until the contact has the
    // whole file, as `send` stays until its message went out. Before, it left in under a second with nothing sent, and
    // the contact saw the file only with a later command that stayed online long enough. A group's file, or one to a chat
    // nobody joined yet: none.
    const wait = oneOf(params, "wait", "group" in target ? ["none"] as const : ["none", "sent"] as const, !("group" in target) && oneShotWaits(ctx, target.link.id) ? "sent" : "none");
    const seconds = num(params, "timeout", 300, { min: 1, max: 86_400 });
    if ("group" in target) return sendToGroup(ctx, params, target.group, path, name, info.size);
    const { link } = target;
    if (link.profile && link.dataLink === "open" && !link.capabilities?.files) throw new CliError("unavailable", "The contact's app takes no files");
    // Only a session open now says what the contact's app takes: with none (the contact away), the file waits and goes
    // as files/3 on the next one (the engine's `sendWaitingFile`), as the app's composer sends it.
    if (link.dataLink === "open" && !link.capabilities?.largeFiles && info.size > LIMITS.maxFileBytes) throw new CliError("refused", `Too large for the contact's app (at most ${LIMITS.maxFileBytes} bytes)`);
    if (typeof link.peerFileRoom === "number" && info.size > link.peerFileRoom) throw new CliError("refused", `Not enough space on the contact's device (${link.peerFileRoom} bytes free)`);
    const mime = mimeOf(path, str(params, "mime"));
    // A reply names a message of this chat, as `send --reply` does: checked before anything is stored.
    const replyTo = str(params, "reply");
    if (replyTo) {
      if (!await findMessage(ctx, link.id, (m) => m.id === replyTo || replyRef(m) === replyTo)) throw noMessage(replyTo, { group: false, ref: str(params, "chat", true) }, { tail: ", or it cannot be replied to" });
    }
    const { voice, warning } = await voiceOf(params, path, mime, info.size);
    const source = await whileUnchanged(path, () => sendable(path, mime));
    // A picture goes with its size, read from its first bytes as the apps read it (PNG, JPEG, GIF, WebP).
    const image = voice ? undefined : await whileUnchanged(path, () => readImageMeta(source, mime));
    const wireId = toBase64Url(randomBytes(12));
    const file: MessageFile = { id: `${link.id}-out-${wireId}`, name, size: source.size, mime, ...(voice ? { voice } : {}), ...(image ? { image } : {}) };
    const timestamp = sentAt();
    const bytes = await fileBytes();
    const digest = await whileUnchanged(path, () => bytes.stage(file.id, source));
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
    // The message's id, as a group's file and `send` answer it: what `message delete`, `react`, `pin` and `--reply` take.
    // The engine names a sent file's row after its time (node.ts `sendFile`), the one given here.
    const messageId = `me_${timestamp}`;
    // A wait that ends short (its time, or the daemon's stop: a restart) leaves the file in the chat, going on as a text
    // does (waits.ts): said so, with its ids. A stop ended the connection under it before, with no id to look for.
    if (wait === "sent") await waitForFile(ctx, { chat: link.id, file: file.id, timeout: seconds }, ctx.stopping).catch((error: unknown) => {
      if (!(error instanceof CliError) || error.code !== "timeout") throw error;
      throw new CliError("timeout", `${error.message}. It is kept here and ${goesOn(ctx, link.id)}`, { ...error.details, chat: link.id, messageId, file: file.id });
    });
    return {
      chat: link.id, messageId, file: { id: file.id, name: file.name, size: file.size, mime: file.mime, ...(voice ? { voice: true } : {}), ...(image ? { image } : {}) }, ...(warning ? { warning } : {}),
      ...keptForJoin(ctx, link.id, "the file"),
    };
  },

  async "file.list"(ctx, params) {
    const target = chatOrGroupOf(ctx, params);
    const views = state(ctx).transfers;
    // A file that finished before this run has no transfer in the engine's state: its record says it is done. Nor has a
    // group's file waiting for a Download: its record says it is not here. Nor has a chat's file sent to a contact who is
    // away, until they are back: its record says how far it went, and it waits for them.
    const keptOf = async (linkId: string) => new Map((await fileStore.listForLink(linkId).catch(() => [])).flatMap((f) => {
      const kept = f.transfer?.state === "done" ? { ...f.transfer, direction: f.direction }
        : !("group" in target) && f.transfer?.state === "transferring" && f.direction === "out" ? { ...f.transfer, direction: f.direction, stage: "waiting" as const, waitingFor: "contact" as const }
        : waitingGroupFile(f);
      return kept ? [[f.id, kept] as const] : [];
    }));
    // The history's file rows only (the messages store's file index): a bot polling this in a chat of 9,000 texts read
    // every one of them each time (75 ms), with the daemon's other calls waiting behind it.
    const linkId = "group" in target ? `group:${target.group.id}` : target.link.id;
    const kept = await keptOf(linkId);
    const files = filesOf(await node(ctx).fileMessages(linkId), (id) => withWaitingFor(views[id] ?? kept.get(id)));
    return "group" in target ? { group: target.group.id, files } : { chat: target.link.id, files };
  },

  /**
   * files/3: answer an offer, or pause, resume or cancel a transfer, either way; `resend` a file sent from here that
   * stopped moving (or failed), `request` again one that stopped arriving. Without a chat, the file's id names it.
   * A group's file (WISP 503) takes `accept` (download one this device did not fetch by itself), `request`, and `cancel`,
   * `decline`, `pause` and `resume` for one that is coming.
   */
  async "file.action"(ctx, params) {
    const fileId = str(params, "file", true);
    const { linkId, where } = fileChat(ctx, params, fileId);
    const action = oneOf(params, "action", ACTIONS, "accept");
    // One all here has no transfer in the engine's state, only its record; the engine takes any action on it and does nothing.
    const refuseAllHere = async () => {
      if ((state(ctx).transfers[fileId] ?? (await fileStore.get(fileId).catch(() => undefined))?.transfer)?.state === "done") throw new CliError("refused", action === "accept" || action === "request" || action === "resume" ? "Nothing to ask for: the file is all here" : "Nothing to stop: the file is all here");
    };
    if ("group" in where) {
      if (action === "resend") throw new CliError("bad_request", "A group's file is downloaded (file accept) or asked for again (file request)");
      await refuseAllHere();
      try { await node(ctx).fileAction({ linkId, fileId, action }); } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
      return { ...where, file: fileId, action, transfer: state(ctx).transfers[fileId] ?? null };
    }
    if (action === "resend" || action === "request") {
      const outgoing = fileId.startsWith(`${linkId}-out-`);
      if (outgoing !== (action === "resend")) throw new CliError("bad_request", outgoing ? "A file sent from here is sent again: file resend" : "A received file is asked for again: file request");
      const transfer = state(ctx).transfers[fileId];
      if (!transfer || transfer.state === "done") throw new CliError("refused", outgoing ? "Nothing to send again: it arrived whole" : "Nothing to ask for: the file is all here");
      if (transfer.state === "failed" && (!outgoing || !transfer.retry)) throw new CliError("refused", `It ended: ${transfer.error ?? "failed"}`);
    } else {
      const outgoing = fileId.startsWith(`${linkId}-out-`);
      if (outgoing && (action === "accept" || action === "decline")) throw new CliError("bad_request", "A file sent from here is not accepted or declined: file cancel stops it");
      await refuseAllHere();
      // One that ended (cancelled, declined, failed): the engine takes the action and does nothing, as for one all here.
      const transfer = state(ctx).transfers[fileId] ?? (await fileStore.get(fileId).catch(() => undefined))?.transfer;
      // Being checked (sent: the contact checks it; received: its digest here): the engine takes no pause and it ends done.
      if (action === "pause" && transfer?.stage === "verifying") throw new CliError("refused", "Too late to pause: it is being checked");
      if (transfer?.state === "failed") throw new CliError("refused", `It ended: ${transfer.error ?? "failed"}${outgoing && transfer.retry ? " (file resend sends it again)" : ""}`);
      // Sent whole (the engine's `sentWhole`): the engine takes no cancel or pause and it ends done, so it is refused, not echoed.
      const whole = outgoing && transfer?.state === "transferring" && (transfer.stage === "verifying"
        || (transfer.size > 0 && transfer.transferred >= transfer.size && transfer.stage !== "asking" && transfer.stage !== "queued" && transfer.stage !== "paused"));
      if (whole && action === "cancel") throw new CliError("refused", "Too late to cancel: it arrived whole, and the contact keeps it");
      if (whole && action === "pause") throw new CliError("refused", "Too late to pause: it arrived whole, and the contact keeps it");
    }
    // Paused by the contact: only their resume moves it. The engine takes these and does nothing, and it stays paused.
    const view = state(ctx).transfers[fileId];
    if ((action === "resume" || action === "request" || action === "resend") && view?.stage === "paused" && view.pausedBy === "peer") {
      throw new CliError("refused", "Paused by the contact: it goes on when they resume it");
    }
    // Offered here and not taken yet: the engine takes these and does nothing, and it still waits for the answer.
    if ((action === "pause" || action === "resume" || action === "request") && view?.stage === "asking" && view.direction === "in") {
      throw new CliError("refused", "Not taken yet: it waits for you to take it (file accept, or file decline)");
    }
    await node(ctx).fileAction({ linkId, fileId, action });
    return { ...where, file: fileId, action, transfer: state(ctx).transfers[fileId] ?? null };
  },

  async "file.wait"(ctx, params) {
    return waitForFile(ctx, params);
  },

  /**
   * Writes a received (or sent) file to disk: into `dir` under its own name (`saveName`), a voice message under the one
   * Ghostly makes for it as the apps' Download does (`voiceDownloadName`, never the sender's; "<name> (2)" when taken),
   * or to `path`. Never over a file unless `force`.
   */
  async "file.save"(ctx, params) {
    const fileId = str(params, "file", true);
    if (params.chat !== undefined) fileChat(ctx, params, fileId);
    // A sent file is all here (below): --wait waited for the contact's download, and failed with their decline.
    if (bool(params, "wait") && (await fileStore.get(fileId))?.direction !== "out") await FILE_METHODS["file.wait"](ctx, { file: fileId, timeout: params.timeout });
    const stored = await fileStore.get(fileId);
    if (!stored?.metadata) throw noFile(fileId);
    if (stored.leftOut) throw new CliError("not_found", "Not in this backup: the light backup this profile was restored from left the file out");
    // A sent file's bytes were staged whole at send: its transfer is the contact's download, not bytes missing here.
    // A group's file waiting for a Download has no transfer in the engine's state: its record says it waits.
    const transfer = stored.direction === "out" ? undefined : state(ctx).transfers[fileId] ?? waitingGroupFile(stored) ?? stored.transfer;
    // One that ended will not come: its partial bytes were dropped, so "not all here yet" would have a script wait for good.
    if (transfer?.state === "failed") throw new CliError("refused", `It ended: ${transfer.error ?? "failed"}`);
    // Nor will one that waits for `file accept`: said naming it, as --wait does. It answered "not all here yet (0 of N
    // bytes)" before, and a script retried it for good.
    if (transfer?.state === "transferring" && transfer.stage === "asking" && transfer.direction === "in") {
      let where;
      try { where = fileChat(ctx, params, fileId).where; } catch { /* a chat no longer here: the file's id names it */ }
      throw waitsForYou(stored.metadata.name, fileId, where, transfer.size);
    }
    if (transfer && transfer.state !== "done") throw new CliError("unavailable", `The file is not all here yet (${transfer.transferred} of ${transfer.size} bytes)`);
    const named = str(params, "path") ? resolve(str(params, "path", true)) : join(resolve(str(params, "dir") ?? "."), saveName(stored.metadata.voice ? voiceDownloadName(stored.metadata.mime, await voiceTime(ctx, stored)) : stored.metadata.name));
    const force = bool(params, "force");
    // A --path that ends in a separator names a folder: resolve() dropped the slash, and "--path downloads/" with no
    // downloads folder left a file named downloads. A folder that is there is answered below, as without the slash.
    const path = str(params, "path");
    if (path && (path.endsWith("/") || path.endsWith(sep)) && !(await stat(named).catch(() => undefined))?.isDirectory()) {
      throw new CliError("bad_request", `${path} names a folder: name a file, or use --dir ${named} (dir over the socket)`);
    }
    // A voice message's name is Ghostly's, down to the second its sender claims: two of one second took one name, and
    // the --force the confirm hinted at replaced the first recording with the other. In --dir it steps to a free
    // "<name> (2)", as a browser's Download does; a --path the user named is never renamed.
    const free = !force && !str(params, "path") && !!stored.metadata.voice;
    const ext = extname(named), stem = named.slice(0, named.length - ext.length);
    // What is at `target` that the save may not go over, as the error that says so; nothing when it may.
    const taken = async (target: string, code?: string): Promise<CliError | undefined> => {
      const there = await stat(target).catch(() => undefined);
      // A folder there is no file to replace: before, it asked for --force, and the --force then failed "is a folder".
      if (there?.isDirectory()) return new CliError("bad_request", `${target} is a folder: name a file, or use --dir ${target} (dir over the socket)`);
      if ((there && !force) || code === "EEXIST") return new CliError("confirm", `${target} exists: pass --force (force: true over the socket) to replace it`);
    };
    let target = named;
    for (let n = 2, refused = await taken(target); refused; n += 1, refused = await taken(target)) {
      if (!free || refused.code !== "confirm" || n > 1000) throw refused;
      target = `${stem} (${n})${ext}`;
    }
    // The bytes go beside it first and take its name only once whole: a save that fails (the bytes not on this device, a
    // full disk) leaves no file, and with --force the one it was to replace as it was. Before, --force emptied that file
    // as it opened it, and the failure removed it.
    const partial = join(dirname(target), `.ghostly-save-${process.pid}-${toBase64Url(randomBytes(6))}.partial`);
    // That name is the save's own: never typed, new on every try, gone after. An error on it (a folder it may not write,
    // a full disk) names `where` instead, the folder or the file asked for. Before, the answer and its `details.path`
    // named the hidden file.
    const asked = (error: unknown, where: string): unknown => {
      const failed = error as NodeJS.ErrnoException;
      if (failed instanceof Error && failed.path === partial) {
        failed.path = where;
        failed.message = failed.message.replaceAll(partial, where);
      }
      return error;
    };
    let out: FileHandle | null;
    try { out = await open(partial, "wx", 0o600); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The folder it goes in is what is missing (or a file): named alone, as `listen --cursor` names its own. Before,
      // Node's whole path ("No such file or folder: <folder>/<name>") read as if the received file were gone.
      if (code === "ENOENT" || code === "ENOTDIR") {
        const folder = dirname(target), there = await stat(folder).catch(() => undefined);
        if (!there) throw new CliError("not_found", `No such file or folder: ${folder}`);
        if (!there.isDirectory()) throw new CliError("not_found", `${folder} is a file, not a folder`);
      }
      // Not made at all: the folder refused it.
      throw asked(error, dirname(target));
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
      await out.close();
      out = null;
      // --force over what is there. Else never over a file that appeared meanwhile: a voice message steps on to a free name.
      for (let n = 2; !complete; n += 1) try { await place(partial, target, force); complete = true; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const refused = code === "EEXIST" || code === "EISDIR" || code === "ENOTEMPTY" ? await taken(target, code) : undefined;
        if (free && refused?.code === "confirm" && n <= 1000) { target = `${stem} (${n})${ext}`; continue; }
        throw refused ?? error;
      }
      // A contact chose its bytes and its name (`.command`, `.lnk`): marked as downloaded. Every save is, as Desktop's:
      // one sent from here may be a contact's forwarded (`copyForForward`), its record "out" with nothing of where it came from.
      await markDownloaded(target);
    } catch (error) {
      throw asked(error, target);
    } finally {
      await out?.close();
      await rm(partial, { force: true });
    }
    return { file: fileId, path: target, size: written, name: stored.metadata.name, mime: stored.metadata.mime };
  },
};
