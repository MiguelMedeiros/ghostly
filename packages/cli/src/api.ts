import { inviteLink, MENTION_EVERYONE, sanitizeTypingStatus, TYPING_KINDS, TYPING_STATUS_MAX, type GroupMention, type PairedTransport, type TypingKind } from "@ghostly/core";
import type { GroupView, Settings, StoredMessage } from "@ghostly/browser/shared/types";
import { findSecret } from "../../../src/lib/parse/secrets";
import { ENGINE_METHODS, ENGINE_READS } from "./engineMethods";
import { CliError } from "./errors";
import type { GhostlyEvent } from "./events";
import {
  bool, chatOf, findChat, findGroup, groupOf, list, node, num, oneOf, state, str, waitForState,
  type ApiContext, type Method, type Params,
} from "./apiKit";
import { FILE_METHODS } from "./files";
import { HOLD_MAX_MINUTES, holdChat, holdOf, releaseHold } from "./holds";
import { endTyping, keepTyping, sayTyping } from "./typing";
import { GROUP_ADMIN_METHODS } from "./groupAdmin";
import { IDENTITY_METHODS } from "./identities";
import { SERVICE_METHODS } from "./services";
import { BACKUP_METHODS } from "./backup";
import { CALL_METHODS } from "./calls/api";
import { WALLET_METHODS } from "./wallets";
import { chatDetailsJson, chatJson, groupJson, groupMessageJson, messageJson, type MessageJson } from "./views";

const DELIVERY_RANK: Record<string, number> = { sending: 0, waiting: 1, queued: 1, held: 2, sent: 2, delivered: 3 };

/** Waits until the contact confirmed the latest edit of one of my messages (it is no longer pending). */
async function waitForEdit(ctx: ApiContext, chat: string, messageId: string, ms: number): Promise<StoredMessage> {
  const until = Date.now() + ms;
  for (;;) {
    const message = (await node(ctx).getMessages(chat)).find((m) => m.id === messageId);
    if (!message) throw new CliError("not_found", `No message ${messageId} in this chat`);
    if (!message.edit?.pending) return message;
    if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: the contact has not confirmed the edit yet. It goes by itself once the chat is live and the contact's app shows edits, while this profile is online`, { messageId, edits: message.edit.seq });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Waits until an edge took my group message, or its edit number `edit` (WISP 9xx: a group has no receipts, so this is
 * as far as the author sees): a member's edge in a private group, an edge to one of my hubs in a community.
 */
async function waitForGroupFrame(ctx: ApiContext, groupId: string, messageId: string, edit: number | undefined, ms: number): Promise<number> {
  const until = Date.now() + ms;
  for (;;) {
    const taken = node(ctx).groupTaken({ groupId, messageId, ...(edit ? { edit } : {}) });
    if (taken > 0) return taken;
    if (Date.now() >= until) throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: no member's edge took it yet. It stays in the group and goes when one opens, while this profile is online`, { messageId, ...(edit ? { edits: edit } : {}) });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Waits until a message of mine reached `target` (`sent`: on its way to the contact; `delivered`: acknowledged). */
async function waitForMessage(ctx: ApiContext, chat: string, messageId: string, target: "sent" | "delivered", ms: number): Promise<StoredMessage> {
  const want = DELIVERY_RANK[target];
  const look = (message: StoredMessage | undefined) => {
    if (!message) return undefined;
    const delivery = message.delivery ?? "sent";
    if (delivery === "failed") throw new CliError("engine", message.deliveryError ?? "The message could not be sent", { messageId, delivery });
    return (DELIVERY_RANK[delivery] ?? 0) >= want ? message : undefined;
  };
  return new Promise<StoredMessage>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, message?: StoredMessage) => {
      if (settled) return;
      settled = true; clearTimeout(timer); off();
      if (error) reject(error); else resolve(message!);
    };
    const check = (last = false) => void node(ctx).getMessages(chat).then((messages) => {
      const message = messages.find((m) => m.id === messageId);
      try {
        const done = look(message);
        if (done) finish(null, done);
        else if (last) finish(new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: the message is ${message?.delivery ?? "not sent yet"} and still goes by itself while this profile is online`, { messageId, delivery: message?.delivery ?? null }));
      } catch (error) { finish(error); }
    }, finish);
    const timer = setTimeout(() => check(true), ms);
    // Any event naming the message: a message first seen already delivered comes as `message.sent`, never as
    // `message.delivery`. Listening before the first read leaves no gap for a change to slip through.
    const off = ctx.hub.onEvent((event: GhostlyEvent) => {
      if (event.chat === chat && (event.messageId === messageId || (event.message as { id?: string } | undefined)?.id === messageId)) check();
    });
    check();
  });
}

// ---------- settings ----------

/** Settings as a bot may read them: storage credentials and other secrets masked unless asked for. */
export function redactSettings(settings: Settings, showSecret = false): Record<string, unknown> {
  if (showSecret) return settings as unknown as Record<string, unknown>;
  const mask = (value: unknown, key = ""): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
    if (Array.isArray(value)) return value.map((item) => mask(item, key));
    if (typeof value === "string" && (/secret|password|token|credential|privatekey|nsec|bunker/i.test(key) || key === "auth" || key === "space")) return "<hidden>";
    return value;
  };
  // The push subscription (wake-up push) is a capability: who holds it can wake this profile's web app.
  const { avatar, wake, ...rest } = settings;
  return { ...(mask(rest) as Record<string, unknown>), ...(avatar ? { avatar: "<set>" } : {}), ...(wake ? { wake: "<set>" } : {}) };
}

/** Settings a command may change; the rest are the app's to manage. */
const SETTABLE: Record<string, "strings" | "string" | "boolean" | "ice"> = {
  relays: "strings", irohRelays: "strings", hyperdhtRelay: "string", readRelays: "boolean",
  iceServers: "ice", publicProfiles: "boolean", online: "boolean", shareProfile: "boolean", sendTyping: "boolean", nick: "string",
};

// ---------- transports ----------

const TRANSPORT_NAMES: Record<string, PairedTransport | "auto" | "dht"> = {
  auto: "auto", dht: "dht", webrtc: "webrtc/1", iroh: "iroh/1", hyperdht: "hyperdht/1",
  "webrtc/1": "webrtc/1", "iroh/1": "iroh/1", "hyperdht/1": "hyperdht/1",
};

// ---------- mentions ----------

/** Code points before `index` (UTF-16) in `text`: mentions count code points (WISP 9xx § Mentions). */
const codePoints = (text: string, index: number) => [...text.slice(0, index)].length;

/**
 * Mentions for a group message: each ref (a member key, a unique prefix of one, a member's name, or `everyone`) must
 * be written in the text as `@<name>` (or `@<key prefix>`, `@everyone`); the first such place is the mention.
 */
export function mentionsFor(text: string, refs: readonly string[], group: GroupView): GroupMention[] {
  const out: GroupMention[] = [];
  for (const ref of refs) {
    let key: string, spelled: string[];
    if (ref === "everyone" || ref === MENTION_EVERYONE) { key = MENTION_EVERYONE; spelled = ["everyone", "all"]; }
    else {
      const lower = ref.toLowerCase();
      // A member's key is that member, whatever another member calls itself.
      const byKey = group.members.filter((m) => !m.me && m.key === ref);
      const matches = byKey.length ? byKey : group.members.filter((m) => !m.me && (m.key.startsWith(ref) || m.nick?.trim().toLowerCase() === lower));
      if (matches.length !== 1) throw new CliError(matches.length ? "bad_request" : "not_found", matches.length ? `${JSON.stringify(ref)} names more than one member` : `No member ${JSON.stringify(ref)} in ${group.name}`);
      key = matches[0].key;
      spelled = [matches[0].nick?.trim(), ref, key.slice(0, 8)].filter((s): s is string => !!s);
    }
    const found = spelled.map((name) => ({ name, index: text.toLowerCase().indexOf("@" + name.toLowerCase()) })).find((f) => f.index >= 0);
    if (!found) throw new CliError("bad_request", `Write @${spelled[0]} in the text to mention ${ref}`);
    out.push({ k: key, o: codePoints(text, found.index), l: [..."@" + found.name].length });
  }
  return out;
}

// ---------- methods ----------

const METHODS: Record<string, Method> = {
  ...WALLET_METHODS,
  ...FILE_METHODS,
  ...GROUP_ADMIN_METHODS,
  ...IDENTITY_METHODS,
  ...SERVICE_METHODS,
  ...BACKUP_METHODS,
  ...CALL_METHODS,

  async status(ctx) {
    const s = state(ctx);
    return {
      version: ctx.version, profile: ctx.runtime.paths.name, mode: ctx.mode, pid: process.pid,
      online: s.settings.online, name: s.settings.nick || null, webrtc: ctx.runtime.webrtc, calls: ctx.runtime.callsUnavailable === null,
      chats: s.links.length, live: s.links.filter((l) => l.textDelivery === "stream").length, groups: s.groups.length,
      discovery: { protocol: s.transport.protocol, relays: s.transport.relays },
      events: { lastSeq: ctx.hub.lastSeq },
    };
  },

  async "profile.get"(ctx) {
    const { settings } = state(ctx);
    return { profile: ctx.runtime.paths.name, name: settings.nick || null, shareProfile: settings.shareProfile !== false, picture: !!settings.avatar, online: settings.online };
  },
  async "profile.set"(ctx, params) {
    const patch: Partial<Settings> = {};
    const name = params.name;
    if (name !== undefined) {
      if (typeof name !== "string" || [...name].length > 64) throw new CliError("bad_request", "name must be a string of up to 64 characters");
      patch.nick = name.trim();
    }
    if (params.shareProfile !== undefined) patch.shareProfile = bool(params, "shareProfile");
    await node(ctx).updateSettings({ settings: patch });
    return METHODS["profile.get"](ctx, {});
  },

  async "settings.get"(ctx, params) {
    return redactSettings(state(ctx).settings, bool(params, "showSecret"));
  },
  async "settings.set"(ctx, params) {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      const kind = SETTABLE[key];
      if (!kind) throw new CliError("bad_request", `${key} is not a setting the CLI changes (${Object.keys(SETTABLE).join(", ")})`);
      if (kind === "strings" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) throw new CliError("bad_request", `${key} must be a list of strings`);
      if (kind === "string" && typeof value !== "string") throw new CliError("bad_request", `${key} must be a string`);
      if (kind === "boolean" && typeof value !== "boolean") throw new CliError("bad_request", `${key} must be true or false`);
      if (kind === "ice" && !(Array.isArray(value) && value.every((v) => v && typeof v === "object"))) throw new CliError("bad_request", `${key} must be a list of ICE servers`);
      patch[key] = value;
    }
    await node(ctx).updateSettings({ settings: patch });
    return redactSettings(state(ctx).settings);
  },

  async "invite.create"(ctx, params) {
    const label = str(params, "label");
    const { linkId, inviteCode } = await node(ctx).createLink();
    if (label) await node(ctx).renameLink({ linkId, label });
    // Native listeners start for the chat on screen (or a paired one): a new invite is the chat a bot waits on.
    node(ctx).setActiveLink({ linkId });
    // Its first records must be out before a one-shot leaves.
    await waitForState(ctx, (s) => { const stage = s.links.find((l) => l.id === linkId)?.pairingProgress?.stage; return stage && stage !== "publishing" ? true : undefined; }, 20_000, "the invite to be published").catch(() => {});
    return { chat: linkId, invite: inviteCode, link: inviteLink(inviteCode) };
  },
  async "invite.join"(ctx, params) {
    let invite = str(params, "invite", true).trim();
    const hash = invite.indexOf("#");
    if (/^https?:\/\//i.test(invite) && hash !== -1) invite = invite.slice(hash + 1);
    let linkId: string;
    try {
      ({ linkId } = await node(ctx).joinLink({ inviteCode: invite }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/own invite/i.test(message)) throw new CliError("refused", message);
      if (/does not look like/i.test(message)) throw new CliError("bad_request", message);
      throw error;
    }
    const label = str(params, "label");
    if (label) await node(ctx).renameLink({ linkId, label });
    node(ctx).setActiveLink({ linkId });
    return { chat: linkId };
  },

  async "chat.list"(ctx) {
    return { chats: state(ctx).links.map(chatJson).sort((a, b) => b.lastMessageAt - a.lastMessageAt || b.createdAt - a.createdAt) };
  },
  async "chat.get"(ctx, params) {
    const link = chatOf(ctx, params);
    return { ...chatDetailsJson(link), heldUntil: holdOf(ctx, link.id) };
  },
  async "chat.history"(ctx, params) {
    const link = chatOf(ctx, params);
    return history(await node(ctx).getMessages(link.id), params);
  },
  async "chat.send"(ctx, params) {
    const link = chatOf(ctx, params);
    const text = str(params, "text", true);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; send it with --force if you mean to`, { kind: secret.kind });
    }
    const wait = oneOf(params, "wait", ["none", "sent", "delivered"] as const, "none");
    const replyTo = str(params, "reply");
    // A kept `typing --for` ends with the message (the engine says stop with it).
    endTyping(ctx, { linkId: link.id }, false);
    const result = await node(ctx).sendMessage({ linkId: link.id, text, ...(replyTo ? { replyTo } : {}) });
    if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
    if (!result.messageId) throw new CliError("bad_request", "Nothing to send");
    let message = (await node(ctx).getMessages(link.id)).find((m) => m.id === result.messageId);
    if (wait !== "none") message = await waitForMessage(ctx, link.id, result.messageId, wait, num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000);
    return { chat: link.id, messageId: result.messageId, delivery: message?.delivery ?? null };
  },
  /**
   * WISP 400 § Edits: the whole new text of one of my texts in a 1:1 chat. It shows here at once and reaches the contact
   * once the chat is live and both apps offer edit/1; `--wait confirmed` waits for the contact to confirm it.
   */
  async "chat.edit"(ctx, params) {
    const link = chatOf(ctx, params);
    const messageId = str(params, "message", true);
    const text = str(params, "text", true);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; edit with --force if you mean to`, { kind: secret.kind });
    }
    const wait = oneOf(params, "wait", ["none", "confirmed"] as const, "none");
    const result = await node(ctx).editMessage({ linkId: link.id, messageId, text });
    if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
    const id = result.messageId ?? messageId;
    let message = (await node(ctx).getMessages(link.id)).find((m) => m.id === id);
    if (wait === "confirmed" && message?.edit?.pending) message = await waitForEdit(ctx, link.id, id, num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000);
    return { chat: link.id, messageId: id, edits: message?.edit?.seq ?? 0, confirmed: !!message && !message.edit?.pending };
  },
  /**
   * WISP 401 § Typing: said on the live session only, and a start only while `sendTyping` is on; it holds 6 s there.
   * `kind` (typing, recording, thinking) and `status` (a short line, e.g. "Transcribing your audio…") say what this
   * side is doing; a new one reaches the contact at once.
   * `for`: kept that many seconds (a one-shot stays that long), until a message to the chat or a stop.
   */
  async "chat.typing"(ctx, params) {
    const link = chatOf(ctx, params);
    const typing = !bool(params, "stop");
    const { kind, status } = typingWord(params, typing);
    const word = { ...(kind !== "typing" ? { kind } : {}), ...(status ? { status } : {}) };
    const seconds = params.for === undefined ? 0 : num(params, "for", 0, { min: 1, max: 600 });
    if (!typing && seconds) throw new CliError("bad_request", "for keeps typing on: not with stop");
    endTyping(ctx, { linkId: link.id }, false);
    node(ctx).setTyping({ linkId: link.id, typing, ...word });
    const until = seconds ? Date.now() + seconds * 1000 : null;
    const kept = seconds ? keepTyping(ctx, { linkId: link.id }, seconds * 1000, word) : null;
    if (kept && ctx.mode === "one-shot") await kept;
    return {
      chat: link.id, typing, ...(typing ? { kind } : {}), ...(status ? { status } : {}),
      live: link.dataLink === "open", sendTyping: state(ctx).settings.sendTyping !== false, ...(until ? { until } : {}),
    };
  },
  /** WISP 400 § Reactions: one emoji per person per message, a new one replaces mine; `remove` takes mine back. */
  async "chat.react"(ctx, params) {
    const link = chatOf(ctx, params);
    return { chat: link.id, ...(await react(ctx, link.id, params)) };
  },
  /**
   * WISP 400 § Forwards: messages of a chat or a group sent on to up to 5 chats and groups, each as a new message of mine
   * that says it was forwarded (one hop more) and nothing of who wrote it. A file goes from the bytes here, never
   * fetched again; a group takes texts only. `wait: sent`: each text until it is on its way (a group's until an edge
   * took it), each file until its transfer is done. What a chat refused comes back per chat; any refusal fails the call.
   */
  async "chat.forward"(ctx, params) {
    const from = chatOrGroup(ctx, str(params, "chat", true));
    const messageIds = list(params, "messages");
    if (!messageIds.length) throw new CliError("bad_request", "Name the messages to forward (their ids, from history or an event)");
    const to = list(params, "to").map((ref) => chatOrGroup(ctx, ref));
    if (!to.length) throw new CliError("bad_request", "Forward to which chat? Name one or more with --to");
    const history = from.group ? await node(ctx).groupMessages({ groupId: from.id }) : await node(ctx).getMessages(from.id);
    const chosen = messageIds.map((id) => history.find((m) => m.id === id) ?? (() => { throw new CliError("not_found", `No message ${id} in this ${from.group ? "group" : "chat"}`); })());
    if (!bool(params, "force")) for (const message of chosen) {
      const secret = message.file ? null : findSecret(message.text);
      if (secret) throw new CliError("confirm", `A message looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; forward it with --force if you mean to`, { kind: secret.kind, messageId: message.id });
    }
    const wait = oneOf(params, "wait", ["none", "sent"] as const, "none");
    let results;
    try { ({ results } = await node(ctx).forwardMessages({ linkId: from.linkId, messageIds, to: to.map((t) => t.linkId) })); }
    catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
    const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
    const out = results.map((result, i) => ({ to: to[i]!.id, kind: to[i]!.group ? "group" as const : "chat" as const, messageIds: result.messageIds, error: result.error }));
    if (wait === "sent") for (const [i, result] of out.entries()) for (const messageId of result.messageIds) {
      if (to[i]!.group) { await waitForGroupFrame(ctx, to[i]!.id, messageId, undefined, ms); continue; }
      const sent = (await node(ctx).getMessages(to[i]!.id)).find((m) => m.id === messageId);
      if (sent?.file) await FILE_METHODS["file.wait"](ctx, { chat: to[i]!.id, file: sent.file.id, timeout: ms / 1000 });
      else await waitForMessage(ctx, to[i]!.id, messageId, "sent", ms);
    }
    const failed = out.filter((r) => r.error);
    if (failed.length) throw new CliError(failed.length === out.length ? "refused" : "engine", failed.map((r) => `${r.to}: ${r.error}`).join("; "), { from: from.id, results: out });
    return { from: from.id, results: out };
  },
  async "chat.retry"(ctx, params) {
    const link = chatOf(ctx, params);
    await node(ctx).retryMessage({ linkId: link.id, messageId: str(params, "message", true) });
    return { chat: link.id, messageId: params.message };
  },
  async "chat.delete"(ctx, params) {
    const link = chatOf(ctx, params);
    const messageId = str(params, "message", true);
    if (!(await node(ctx).getMessages(link.id)).some((m) => m.id === messageId)) throw new CliError("not_found", `No message ${messageId} in this chat`);
    await node(ctx).deleteMessage({ linkId: link.id, messageId });
    return { chat: link.id, deleted: messageId };
  },
  async "chat.details"(ctx, params) {
    const link = chatOf(ctx, params);
    const details = await node(ctx).messageDetails({ linkId: link.id, messageId: str(params, "message", true) });
    if (!details) throw new CliError("not_found", `No message ${String(params.message)} in this chat`);
    return details;
  },
  async "chat.rename"(ctx, params) {
    const link = chatOf(ctx, params);
    await node(ctx).renameLink({ linkId: link.id, label: str(params, "name") ?? "" });
    return chatJson(findChat(state(ctx).links, link.id));
  },
  async "chat.remove"(ctx, params) {
    const link = chatOf(ctx, params);
    if (!bool(params, "yes")) throw new CliError("confirm", "Removing a chat deletes its keys and history on this device; pass yes (--yes) to go on");
    await node(ctx).removeLink({ linkId: link.id });
    return { removed: link.id };
  },
  async "chat.transport"(ctx, params) {
    const link = chatOf(ctx, params);
    const name = str(params, "transport", true);
    const transport = TRANSPORT_NAMES[name];
    if (!transport) throw new CliError("bad_request", `transport must be one of auto, dht, webrtc, iroh, hyperdht`);
    await node(ctx).setChatTransport({ linkId: link.id, transport });
    return chatDetailsJson(findChat(state(ctx).links, link.id));
  },
  /** Reconnects now; a chat held off its direct link (`chat disconnect --hold`) leaves the hold first. */
  async "chat.connect"(ctx, params) {
    const link = chatOf(ctx, params);
    await releaseHold(ctx, link.id, "connect");
    await node(ctx).connect({ linkId: link.id });
    return chatJson(findChat(state(ctx).links, link.id));
  },
  /**
   * Closes the live session; the contact's app may dial again at once. `hold` (minutes): the chat stays off its
   * direct link that long, on the DHT (its "DHT only" choice, taken back after); 0 ends a hold now.
   */
  async "chat.disconnect"(ctx, params) {
    const link = chatOf(ctx, params);
    if (params.hold === undefined) {
      node(ctx).disconnect({ linkId: link.id });
      return chatJson(findChat(state(ctx).links, link.id));
    }
    const minutes = num(params, "hold", 0, { min: 0, max: HOLD_MAX_MINUTES });
    if (minutes === 0) await releaseHold(ctx, link.id, "lifted");
    else await holdChat(ctx, link, minutes);
    return { ...chatJson(findChat(state(ctx).links, link.id)), heldUntil: holdOf(ctx, link.id) };
  },
  async "chat.verify"(ctx, params) {
    const link = chatOf(ctx, params);
    const code = str(params, "code", true).replace(/\s+/g, "").toLowerCase();
    const mine = link.pairing?.code?.replace(/\s+/g, "").toLowerCase();
    if (!mine) throw new CliError("unavailable", "This chat shows no comparison code yet (it needs a live session)");
    if (code !== mine) throw new CliError("refused", "The code does not match the one this side shows: do not trust this chat until you know why");
    await node(ctx).confirmPair({ linkId: link.id, code: link.pairing!.code! });
    return chatJson(findChat(state(ctx).links, link.id));
  },
  async "chat.wait"(ctx, params) {
    const link = chatOf(ctx, params);
    const until = oneOf(params, "until", ["live", "text", "paired"] as const, "live");
    const ms = num(params, "timeout", 60, { min: 1, max: 86_400 }) * 1000;
    const view = await waitForState(ctx, (s) => {
      const now = s.links.find((l) => l.id === link.id);
      if (!now) throw new CliError("not_found", `Chat ${link.id} was removed`);
      const ok = until === "live" ? now.textDelivery === "stream"
        : until === "text" ? now.textDelivery === "stream" || now.textDelivery === "dht" || now.textDelivery === "hold"
        : !!now.pairingProgress?.peerSeen || now.pairing?.status === "ready" || now.textDelivery === "stream";
      return ok ? now : undefined;
    }, ms, `chat ${link.id} to be ${until}`);
    return chatJson(view);
  },

  async "group.create"(ctx, params) {
    const name = str(params, "name", true);
    const profile = oneOf(params, "profile", ["community", "mesh"] as const, "community");
    const { groupId } = await node(ctx).createGroup({ name, profile });
    let link: string | null = null;
    if (profile === "community") ({ link } = await node(ctx).enableGroupLink({ groupId }));
    return { group: groupId, link };
  },
  async "group.join"(ctx, params) {
    const { groupId } = await node(ctx).joinGroupByLink({ link: str(params, "link", true) });
    return { group: groupId };
  },
  async "group.list"(ctx, params) {
    const showSecret = bool(params, "showSecret");
    return { groups: state(ctx).groups.map((g) => groupJson(g, showSecret)).sort((a, b) => b.lastMessageAt - a.lastMessageAt) };
  },
  async "group.get"(ctx, params) {
    return groupJson(groupOf(ctx, params), bool(params, "showSecret"));
  },
  async "group.history"(ctx, params) {
    const group = groupOf(ctx, params);
    return history(await node(ctx).groupMessages({ groupId: group.id }), params, (m) => groupMessageJson(m, group));
  },
  async "group.send"(ctx, params) {
    const group = groupOf(ctx, params);
    const text = str(params, "text", true);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", "The text looks like a secret or a Cashu token; send it with --force if you mean to", { kind: secret.kind });
    }
    const mentions = mentionsFor(text, list(params, "mentions"), group);
    const replyTo = str(params, "reply");
    const wait = oneOf(params, "wait", ["none", "sent"] as const, "none");
    // A kept `group typing --for` ends with the message (the engine says stop with it).
    endTyping(ctx, { groupId: group.id }, false);
    const result = await node(ctx).sendGroupMessage({ groupId: group.id, text, ...(mentions.length ? { mentions } : {}), ...(replyTo ? { replyTo } : {}) });
    if (result.error) throw new CliError("unavailable", result.error);
    const messageId = result.messageId ?? null;
    // `edges`: how many took it so far (none yet is not an error: it goes when one opens).
    const edges = messageId ? (wait === "sent" ? await waitForGroupFrame(ctx, group.id, messageId, undefined, num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000) : node(ctx).groupTaken({ groupId: group.id, messageId })) : 0;
    return { group: group.id, messageId, sent: true, edges };
  },
  /**
   * WISP 9xx § Edits: the whole new text of one of my messages in a group. It shows here at once and goes to the members
   * (a private group's over the edges that are up, the others when theirs open; a community's through the group).
   * `mentions`: members the new text names beyond those the message named. `sent`: no longer waiting for the pace.
   */
  async "group.edit"(ctx, params) {
    const group = groupOf(ctx, params);
    const messageId = str(params, "message", true);
    const text = str(params, "text", true);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", `The text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; edit with --force if you mean to`, { kind: secret.kind });
    }
    const mentions = mentionsFor(text, list(params, "mentions"), group);
    const wait = oneOf(params, "wait", ["none", "sent"] as const, "none");
    const result = await node(ctx).editMessage({ linkId: `group:${group.id}`, messageId, text, ...(mentions.length ? { mentions } : {}) });
    if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
    const message = (await node(ctx).groupMessages({ groupId: group.id })).find((m) => m.id === messageId);
    const edits = message?.edit?.seq ?? 0;
    // An edit waiting for the pace is not said yet: `--wait sent` waits for that too, then for an edge to take it.
    const edges = !edits ? 0 : wait === "sent" ? await waitForGroupFrame(ctx, group.id, messageId, edits, num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000)
      : node(ctx).groupTaken({ groupId: group.id, messageId, edit: edits });
    return { group: group.id, messageId, edits, sent: edges > 0 || (!!message && !message.edit?.pending), edges };
  },
  async "group.react"(ctx, params) {
    const group = groupOf(ctx, params);
    return { group: group.id, ...(await react(ctx, `group:${group.id}`, params)) };
  },
  /**
   * WISP 9xx · Group Mesh § Typing: `chat.typing` in a private group, said on the edges that are open (`reached`: to
   * how many members), with the same kinds, status rules, 6 s hold and `for`. A community does not carry typing yet.
   */
  async "group.typing"(ctx, params) {
    const group = groupOf(ctx, params);
    if (group.profile !== "mesh") throw new CliError("unavailable", "A community does not carry typing yet: only a private group does");
    const typing = !bool(params, "stop");
    const { kind, status } = typingWord(params, typing);
    const word = { ...(kind !== "typing" ? { kind } : {}), ...(status ? { status } : {}) };
    const seconds = params.for === undefined ? 0 : num(params, "for", 0, { min: 1, max: 600 });
    if (!typing && seconds) throw new CliError("bad_request", "for keeps typing on: not with stop");
    if (typing && group.status !== "active") throw new CliError("bad_request", "You are not in this group");
    const target = { groupId: group.id };
    endTyping(ctx, target, false);
    sayTyping(ctx, target, typing, word);
    const until = seconds ? Date.now() + seconds * 1000 : null;
    const kept = seconds ? keepTyping(ctx, target, seconds * 1000, word) : null;
    if (kept && ctx.mode === "one-shot") await kept;
    return {
      group: group.id, typing, ...(typing ? { kind } : {}), ...(status ? { status } : {}),
      reached: group.members.filter((m) => !m.me && m.online && !m.viaHub).length, sendTyping: state(ctx).settings.sendTyping !== false, ...(until ? { until } : {}),
    };
  },
  async "group.leave"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).leaveGroup({ groupId: group.id });
    return { left: group.id };
  },
  async "group.forget"(ctx, params) {
    const group = groupOf(ctx, params);
    if (!bool(params, "yes")) throw new CliError("confirm", "Forgetting a group deletes its history on this device; pass yes (--yes) to go on");
    await node(ctx).forgetGroup({ groupId: group.id });
    return { forgotten: group.id };
  },
  async "group.accept"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).acceptGroupInvitation({ groupId: group.id });
    return { group: group.id };
  },
  async "group.decline"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).declineGroupInvitation({ groupId: group.id });
    return { group: group.id };
  },

  async "events.replay"(ctx, params) {
    return { events: ctx.hub.replay(num(params, "since", 0)), lastSeq: ctx.hub.lastSeq };
  },

  async "daemon.stop"(ctx) {
    if (ctx.mode !== "daemon" || !ctx.stop) throw new CliError("unavailable", "No daemon runs this profile");
    setTimeout(() => ctx.stop!(), 10);
    return { stopping: true, pid: process.pid };
  },

  async "engine.call"(ctx, params) {
    const method = str(params, "method", true);
    if (!ENGINE_METHODS.includes(method) && !ENGINE_READS.includes(method)) throw new CliError("not_found", `The engine has no call ${method}`);
    const raw = params.params;
    if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) throw new CliError("bad_request", "params must be an object");
    let args = raw as Params | undefined;
    // Real money moves only on an explicit confirmation of this call (WISP 11xx § Mainnet).
    if (args && "confirmedReal" in args && !bool(params, "confirmReal")) {
      throw new CliError("confirm", `${method} spends real money: pass --confirm-real (confirmReal: true over the socket) to confirm it`);
    }
    if (method === "getMessages") return node(ctx).getMessages(str(args ?? {}, "linkId", true));
    if (method === "getState") return state(ctx);
    const target = (node(ctx) as unknown as Record<string, (p?: unknown) => unknown>)[method];
    if (typeof target !== "function") throw new CliError("not_found", `The engine has no call ${method}`);
    if (args === undefined) args = undefined;
    return (await target.call(node(ctx), args)) ?? null;
  },
};

/** Reacts to a message of a chat or a group (`group:<id>`): `emoji`, or `remove` for "" (WISP 400 § Reactions). */
/**
 * A chat or a group, as `forward` names them: `group:<id>` is a group; anything else a chat first (id, prefix or name),
 * then a group. `linkId` is what the engine calls it.
 */
function chatOrGroup(ctx: ApiContext, ref: string): { id: string; linkId: string; group: boolean } {
  if (ref.startsWith("group:")) { const group = findGroup(state(ctx).groups, ref.slice("group:".length)); return { id: group.id, linkId: `group:${group.id}`, group: true }; }
  try {
    const link = findChat(state(ctx).links, ref);
    return { id: link.id, linkId: link.id, group: false };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found") throw error;
    const group = findGroup(state(ctx).groups, ref);
    return { id: group.id, linkId: `group:${group.id}`, group: true };
  }
}

async function react(ctx: ApiContext, linkId: string, params: Params): Promise<{ messageId: string; emoji: string | null; removed: boolean }> {
  const messageId = str(params, "message", true);
  const removed = bool(params, "remove");
  const emoji = removed ? "" : str(params, "emoji");
  if (!removed && !emoji) throw new CliError("usage", "Give one emoji, or --remove to take yours back");
  const result = await node(ctx).react({ linkId, messageId, emoji: emoji ?? "" });
  if (result.error) throw new CliError(/not in this chat|No reaction of yours/.test(result.error) ? "not_found" : "bad_request", result.error);
  return { messageId, emoji: emoji || null, removed };
}

/**
 * What `typing` says: a kind, and a status a bot writes. The contact's app would cut a long status and drop one with
 * a link; here that is an error instead, so the bot learns what the contact will (not) see.
 */
function typingWord(params: Params, typing: boolean): { kind: TypingKind; status?: string } {
  const kind = oneOf(params, "kind", TYPING_KINDS, "typing");
  const raw = str(params, "status");
  if (!typing && (params.kind !== undefined || raw !== undefined)) throw new CliError("bad_request", "kind and status go with a start, not with stop");
  if (raw === undefined) return { kind };
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if ([...oneLine].length > TYPING_STATUS_MAX) throw new CliError("bad_request", `status: at most ${TYPING_STATUS_MAX} characters`);
  const status = sanitizeTypingStatus(oneLine);
  if (!status) throw new CliError("bad_request", "status: plain text, with no link or markup");
  return { kind, status };
}

function history(messages: StoredMessage[], params: Params, json: (message: StoredMessage) => MessageJson = messageJson) {
  const limit = num(params, "limit", 50, { min: 1, max: 10_000 });
  const before = params.before;
  const after = params.after;
  let list = messages.slice().sort((a, b) => a.timestamp - b.timestamp);
  const cut = (value: unknown, side: "before" | "after") => {
    if (value === undefined || value === null) return;
    if (typeof value === "number") { list = list.filter((m) => (side === "before" ? m.timestamp < value : m.timestamp > value)); return; }
    if (typeof value !== "string") throw new CliError("bad_request", `${side} must be a timestamp or a message id`);
    const index = list.findIndex((m) => m.id === value);
    if (index === -1) throw new CliError("not_found", `No message ${value}`);
    list = side === "before" ? list.slice(0, index) : list.slice(index + 1);
  };
  cut(before, "before");
  cut(after, "after");
  const more = after !== undefined && after !== null ? list.length > limit : list.length > limit;
  const page = after !== undefined && after !== null ? list.slice(0, limit) : list.slice(-limit);
  return { messages: page.map((m) => json(m)), more };
}

export { findChat, findGroup } from "./apiKit";
export type { ApiContext } from "./apiKit";
export const API_METHODS: readonly string[] = Object.keys(METHODS);

/** Runs one method of the API. */
export async function callApi(ctx: ApiContext, method: string, params: unknown = {}): Promise<unknown> {
  const run = METHODS[method];
  if (!run) throw new CliError("not_found", `No method ${method}`);
  if (params === null || typeof params !== "object" || Array.isArray(params)) throw new CliError("bad_request", "params must be an object");
  return run(ctx, params as Params);
}
