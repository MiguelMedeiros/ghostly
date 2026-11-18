import { AWAITING_PEER_MS, COMMUNITY_LIMITS, DHT_PACKET_BUDGET, decodeCommunityLink, decodeGroupEntryLink, GROUP_EDIT_TEXT_BYTES, GROUP_LIMITS, inviteLink, LIMITS, MENTION_EVERYONE, MENTION_LIMITS, normalizeRelayUrl, ownInviteRefusal, relayUrlProblem, replySnippet, STATUS_CARD_LIMITS, statusCardBytes, TYPING_KINDS, type GroupMention, type TypingKind } from "@ghostly/core";
import type { EngineState, GroupView, LinkView, Settings, StoredMessage } from "@ghostly/browser/shared/types";
import { iceServerProblem, iceServerSetting } from "@ghostly/browser/shared/ice";
import { DEFAULT_HYPERDHT_RELAY } from "@ghostly/browser/shared/hyperdhtRelay";
import { groupPayLineId, groupPayNoteId } from "@ghostly/browser/shared/groupPayNotes";
import { DEFAULT_IROH_RELAYS } from "@ghostly/browser/platform/irohWeb";
import { FORWARD_MESSAGES, FORWARD_TARGETS } from "@ghostly/browser/engine/forwards";
import { findSecret, guardText, secretWords } from "./secretGuard";
import { DESTRUCTIVE_CALLS, ENGINE_METHODS, ENGINE_PARAMS, ENGINE_READS, READ_PARAMS, engineParamsProblem } from "./engineMethods";
import { asCliError, CliError } from "./errors";
import { shellWord } from "./shellWord";
import {
  bool, chatOf, chatOrGroup, dhtOnly, findChat, findChatOrGroup, findGroup, groupById, groupCalled, groupNameOf, groupOf, groupPrefixed, groupsNotChat, inviteTaken, keptForJoin, list, messageOf, noMessage, nobodyJoined, node, notInYet, notInYetError, num, oneOf, oneShotWaits, settingsOf, sharedGroupIds, shownName, sinceSeq, somebodyJoined, state, str, transportOffered, waitForState,
  type ApiContext, type CallScope, type Method, type Params, type RefPlace,
} from "./apiKit";
import { FILE_METHODS } from "./files";
import { checkShownName } from "./profiles";
import { ended, foldsAnyway, goesOn, nobodyElseIn, outOf, purgeMessage, waitForConfirmed, waitForEdit, waitForGroupFrame, waitForMessage, waitForRemoval } from "./waits";
import { STATUS_CARD_METHODS, secretIn } from "./statusCards";
import { BUTTON_METHODS, buttonsCard, pressable } from "./buttons";
import { forgetHold, HOLD_MAX_MINUTES, holdChat, holdEnds, holdOf, releaseHold } from "./holds";
import { endTyping, keepOneShot, keepTyping, ONE_SHOT_LIVE_GRACE_MS, sayTyping, typingStatus } from "./typing";
import { GROUP_ADMIN_METHODS, moreThanOneMember, noMember, withUrl } from "./groupAdmin";
import { withStoredIds } from "./turnRefs";
import { IDENTITY_METHODS } from "./identities";
import { X401_METHODS } from "./x401";
import { closeServicesOf, SERVICE_METHODS, serviceShape } from "./services";
import { BACKUP_METHODS } from "./backup";
import { CALL_METHODS } from "./calls/api";
import { APP_SERVE_METHODS } from "./appServe";
import { APP_CHAT_METHODS } from "./appChat";
import { mintUrlShape, payShape, tokenShape, WALLET_METHODS } from "./wallets";
import { checkOwnStatus, statusJson } from "./ownStatus";
import { TRANSPORT_NAMES } from "./words";
import { chatState, dhtOnlyNote, heldWords, pinWaitsNote, type DhtOnly } from "./waitNotice";
import { chatDetailsJson, chatJson, chatMessageJson, groupJson, groupMessageJson, groupPayTwins, isLive, messageJson, type MessageJson } from "./views";

/**
 * A text past what a chat or a group carries (16 KiB of UTF-8, as the engine counts it: trimmed) is refused before the
 * engine is asked, with a code that says it never goes as it is, not "unavailable", which reads as "try later".
 */
function checkTextSize(text: string): void {
  const bytes = new TextEncoder().encode(text.trim()).length;
  if (bytes > LIMITS.maxChatMessageBytes) throw new CliError("bad_request", `Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes (${bytes}): shorten it, or send it as a file`, { bytes, max: LIMITS.maxChatMessageBytes });
}

// ---------- settings ----------

/**
 * The engine's state as `engine getState` prints it without `--show-secret`: the settings' credentials, a group's
 * entry link and the link of another group kept under its id (anyone who reads one can join), a pending chat's
 * invite code (whoever reads it can take the chat) and this side's wake-up tokens are `<hidden>`.
 */
export function hideStateSecrets<T extends {
  settings: Settings;
  groups?: { entryLink?: string; others?: unknown[]; wakeTokens?: string[] }[];
  links?: { inviteCode?: string; wakeToken?: string }[];
}>(state: T) {
  const hideOther = (o: unknown) => (o && typeof o === "object" && "link" in o ? { ...o, link: "<hidden>" } : o);
  return {
    ...state,
    settings: redactSettings(state.settings),
    ...(state.groups ? { groups: state.groups.map((g) => ({ ...g,
      ...(g.entryLink ? { entryLink: "<hidden>" } : {}),
      ...(g.others ? { others: g.others.map(hideOther) } : {}),
      ...(g.wakeTokens ? { wakeTokens: g.wakeTokens.map(() => "<hidden>") } : {}) })) } : {}),
    ...(state.links ? { links: state.links.map((l) => ({ ...l,
      ...(l.inviteCode ? { inviteCode: "<hidden>" } : {}),
      ...(l.wakeToken ? { wakeToken: "<hidden>" } : {}) })) } : {}),
  };
}

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
const SETTABLE_KINDS = {
  relays: "strings", irohRelays: "strings", hyperdhtRelay: "string",
  iceServers: "ice", publicProfiles: "boolean", online: "boolean", shareProfile: "boolean", sendTyping: "boolean", nick: "string",
  autoDownloads: "boolean", serveFiles: "boolean", daemonPresence: "boolean",
} as const satisfies Partial<Record<keyof Settings, "strings" | "string" | "boolean" | "ice">>;
export const SETTABLE: Record<string, "strings" | "string" | "boolean" | "ice"> = SETTABLE_KINDS;

type Settable = keyof typeof SETTABLE_KINDS;
/**
 * What a setting of the table reads as while the engine keeps none (types.ts `Settings`): a switch that is on and the
 * default relays are kept as absent (node.ts `updateSettings` deletes `sendTyping: true`, an empty `irohRelays`...).
 * Every key of the table the engine may leave out needs one here, or tsc fails.
 */
const SETTING_DEFAULTS: { [K in Settable as undefined extends Settings[K] ? K : never]-?: () => NonNullable<Settings[K]> } = {
  irohRelays: () => [...DEFAULT_IROH_RELAYS], hyperdhtRelay: () => DEFAULT_HYPERDHT_RELAY,
  publicProfiles: () => true, shareProfile: () => true, sendTyping: () => true, autoDownloads: () => true, serveFiles: () => true,
  daemonPresence: () => false,
};

/**
 * The settings as `settings get` and `settings set` answer them: each key `settings set` takes, with its value in
 * effect. Before, a switch that is on (absent as kept) was never shown, and a fresh profile showed 4 of the 11 keys.
 */
export function settingsInEffect(settings: Settings): Settings {
  const filled: Record<string, unknown> = { ...settings };
  for (const key of Object.keys(SETTABLE_KINDS) as Settable[]) {
    if (filled[key] === undefined && Object.hasOwn(SETTING_DEFAULTS, key)) filled[key] = SETTING_DEFAULTS[key as keyof typeof SETTING_DEFAULTS]();
  }
  return filled as unknown as Settings;
}

/**
 * A relay address the engine refuses (node.ts `updateSettings`, irohWeb.ts, hyperdhtRelay.ts): the person's value, so
 * `bad_request` named by its key, in a terminal's words ("give", not the app's "Enter"). Before, `engine` (exit 1). A
 * wrong scheme ("Use an https:// relay address") too.
 */
function relayRefused(error: unknown, patch: Record<string, unknown>): unknown {
  if (!(error instanceof Error) || !/^(?:Enter (?:at least one|a) relay address|Not a relay address|Use an? \S+ relay address)\b/.test(error.message)) return error;
  const keys = ["relays", "irohRelays", "hyperdhtRelay"].filter((key) => Object.hasOwn(patch, key));
  return new CliError("bad_request", `${keys.join(", ") || "relays"}: ${error.message.replace(/^Enter /, "give ").replace(/^(Not|Use) /, (word) => word.toLowerCase())}`);
}

// ---------- chat names ----------

/** The engine keeps a chat's name to 48 characters (code points: `renameLink`). */
const CHAT_NAME_LENGTH = 48;

/**
 * A chat's name on this side (`chat rename`, an invite's `--label`), as the engine stores it (`shownName`): a tab or a
 * line break is a space, invisible characters go, and what is left is counted. Longer than the engine keeps whole is
 * refused, not cut. An empty name (or spaces) is the documented one of `chat rename` (the contact's own name) and no
 * label for an invite; a name with nothing that shows is refused: given as is, the engine cleared the chat's name. A
 * name starting with `group:` is refused: `group:<ref>` names a group in every command (`groupPrefixed`).
 */
function chatName(params: Params, name: string): string | undefined {
  const value = str(params, name);
  if (value === undefined || !value.trim()) return value === undefined ? undefined : "";
  const clean = shownName(value, CHAT_NAME_LENGTH, "A chat's name", " (an empty name gives back the contact's own)");
  if (groupPrefixed(clean) !== null) throw new CliError("bad_request", `A chat's name can't start with "group:": that names a group`);
  return clean;
}

// ---------- mentions ----------

/** Code points before `index` (UTF-16) in `text`: mentions count code points (WISP 902 § Mentions). */
const codePoints = (text: string, index: number) => [...text.slice(0, index)].length;

/**
 * What can't follow a whole `@name`: a letter, a mark, a digit or "_". The app's composer ends a token the same way
 * (`composeMentions`, letters, digits and "_"); a mark is part of the letter before it ("@Al" + U+0301 is "@Ál").
 */
const NAME_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;

/**
 * Where `@name` first stands in `text`, without regard to case, or null. `whole`: only where no name character
 * follows it, so `@Al` is not the start of `@Alice`. The regex's case folding keeps each character's length, so the
 * match is a place in the text as written: one found in `text.toLowerCase()` came a character late after a letter
 * that lowercases longer ("İ").
 */
function mentionIn(text: string, name: string, whole: boolean): RegExpExecArray | null {
  const literal = name.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  return new RegExp(`@${literal}${whole ? `(?!${NAME_CHAR})` : ""}`, "iu").exec(text);
}

/**
 * Mentions for a group message: each ref (a member key, a unique prefix of one, a member's name, or `everyone`) must
 * be written in the text as `@<name>` (or `@<key>`, `@<key prefix>`, `@everyone`); the first such place that stands
 * whole is the mention (with none whole, the first place one starts a longer word, as before). A ref
 * more than one member answers to, none does, or this profile itself (`myName`: reads its own name, only for a ref no
 * member answers to) is refused as `group remove` refuses it: before, its own name was "No member", and two members
 * of one name gave no key. `groupRef`: the group as the command named it, for the refusal's hint. A ref given twice is
 * one mention; more refs than a message carries (`MENTION_LIMITS.count`) are refused before any is looked up: the
 * engine dropped the whole list, and the message went out mentioning no one.
 */
export function mentionsFor(text: string, given: readonly string[], group: GroupView, myName?: () => string | undefined, groupRef?: string): GroupMention[] {
  const refs = [...new Set(given)];
  if (refs.length > MENTION_LIMITS.count) throw new CliError("bad_request", `A message mentions at most ${MENTION_LIMITS.count} members (${refs.length} given): send it to fewer, or mention everyone`, { mentions: refs.length, max: MENTION_LIMITS.count });
  const out: GroupMention[] = [];
  for (const ref of refs) {
    let key: string, spelled: string[];
    if (ref === "everyone" || ref === MENTION_EVERYONE) { key = MENTION_EVERYONE; spelled = ["everyone", "all"]; }
    else {
      const lower = ref.toLowerCase();
      // A member's key is that member, whatever another member calls itself.
      const byKey = group.members.filter((m) => !m.me && m.key === ref);
      const matches = byKey.length ? byKey : group.members.filter((m) => !m.me && (m.key.startsWith(ref) || m.nick?.trim().toLowerCase() === lower));
      if (matches.length > 1) throw moreThanOneMember(group, ref, matches, groupRef);
      if (!matches.length) throw noMember(group, ref, myName?.(), groupRef);
      key = matches[0].key;
      spelled = [matches[0].nick?.trim(), ref, key, key.slice(0, 8)].filter((s): s is string => !!s);
    }
    const first = (whole: boolean) => spelled.map((name) => mentionIn(text, name, whole)).find((m) => m !== null);
    const found = first(true) ?? first(false);
    if (!found) throw new CliError("bad_request", `Write @${spelled[0]} in the text to mention ${ref}`);
    out.push({ k: key, o: codePoints(text, found.index), l: [...found[0]].length });
  }
  return out;
}

/** Per host: stops watching the invite it marked as the chat on screen. */
const inviteShown = new WeakMap<ApiContext, () => void>();

/**
 * Refuses DHT only (a hold, `chat transport dht`) while a call is on in the chat. A call's signals cross the live
 * link: off it, the call talked on over its own connection, and a hang-up from either side never reached the other
 * (that call ended only when its media stalled out, 16 s later). Removing the chat (`chat remove`) is refused the same
 * way: the call talked on in a chat gone from this device, and its hang-up had no chat left to cross. `engine.call`
 * refuses the raw calls that do the same (`removeLink`, `setChatTransport` / `setDeliveryMode` to `dht`).
 */
function noCallOn(ctx: ApiContext, linkId: string, then: string): void {
  const call = ctx.calls.list().find((c) => c.chat === linkId);
  if (call) throw new CliError("busy", `A call is on in this chat: hang it up first (ghostly call hangup ${linkId}), then ${then}`, { call: call.call });
}

/**
 * Marks a new invite as the chat on screen (native listeners, the quick pace) only until it is paired: a paired chat
 * keeps its listeners anyway, and a daemon nobody looks at reads an away contact at the background pace, as its
 * other chats and the same chat after a restart do. Nor past its wait for a peer (`AWAITING_PEER_MS`): an invite
 * nobody joined is then read at the background pace like the daemon's other ones, which it no longer holds back.
 */
function showUntilPaired(ctx: ApiContext, linkId: string): void {
  inviteShown.get(ctx)?.();
  node(ctx).setActiveLink({ linkId });
  // Gone only once a state had it: one pushed before the invite was made does not end it.
  let seen = false;
  const done = (s: EngineState) => {
    const link = s.links.find((l) => l.id === linkId);
    if (link) seen = true;
    return link ? !!link.peerParticipationKey : seen;
  };
  const stop = () => { off(); clearTimeout(timer); if (inviteShown.get(ctx) === stop) inviteShown.delete(ctx); };
  const hide = () => { stop(); node(ctx).setActiveLink({ linkId: null }); };
  const timer = setTimeout(hide, AWAITING_PEER_MS);
  timer.unref?.();
  const off = ctx.hub.onState((s) => { if (done(s)) hide(); });
  inviteShown.set(ctx, stop);
}

/**
 * `invite create`'s `reason` when no relay took the invite. The engine's words ("Publish failed on every relay: Error:
 * http://… did not answer a moment ago; retry shortly; Error: …") read as the CLI failing, a class name per relay, beside
 * a `note` that says the invite is good: the relays are named, and nothing is asked of whoever reads it.
 */
function inviteNotOut(detail: string): string {
  if (!detail.startsWith("Publish failed on every relay:")) return detail;
  const hosts = [...new Set([...detail.matchAll(/\bhttps?:\/\/[^\s;,]+/g)].map(([url]) => URL.canParse(url) ? new URL(url).host : url))];
  const named = hosts.length ? ` (${hosts.join(", ")})` : "";
  // A relay that answered with an error status took the request: "did not answer" would not be true of it.
  return `${/ responded \d{3}\b/.test(detail) ? "No relay took the invite" : "No relay answered"}${named}: it goes out once one does`;
}

/** V8's words for reading what a value does not have: an `engine.call` given a parameter of the wrong kind. */
const BAD_VALUE = /^Cannot (destructure|read properties of (undefined|null))|is not (a function|iterable)/;

/** A one-shot's typing without `--for` (it opens the profile offline, `offlineCall`): said on no live session. */
const ONE_SHOT_TYPING = "Typing is said on a live session only, and a one-shot has none: it reached nobody. Keep the profile online (`ghostly daemon --detach`), or give --for to wait until it is live";
// A stop takes no --for, so only the daemon half holds.
const ONE_SHOT_TYPING_STOP = "A stop is said on a live session only, and a one-shot has none: it reached nobody. Keep the profile online (`ghostly daemon --detach`)";
// A one-shot's --for that ended with nobody to see it (`keepOneShot`): it answered `typing: true`, an `until` to come, no note.
const ONE_SHOT_TYPING_UNSEEN = `Typing is said on a live session only, and none came up in time (a one-shot waits up to ${ONE_SHOT_LIVE_GRACE_MS / 1000} s for one): it reached nobody, and it is off. Keep the profile online (\`ghostly daemon --detach\`) so the chat is live when you say it`;

/** A one-shot typing's `note`: without `--for` it reached nobody; with it, only when nobody was live to see it. */
function oneShotTypingNote(ctx: ApiContext, typing: boolean, kept: boolean, seen: boolean): { note: string } | undefined {
  if (ctx.mode !== "one-shot") return undefined;
  if (!kept) return { note: typing ? ONE_SHOT_TYPING : ONE_SHOT_TYPING_STOP };
  return seen ? undefined : { note: ONE_SHOT_TYPING_UNSEEN };
}

// ---------- methods ----------

/**
 * A removal on its way goes with the chat's row, and the contact kept the message for good, though `message delete
 * --everyone` had said its removal goes on: `chat remove`, the engine's `removeLink` and `clearProfileData` (every
 * chat's row at once) are refused until `--force`.
 */
function noRemovalOnItsWay(ctx: ApiContext, linkIds: readonly string[], clearing = false): void {
  const pending = linkIds.flatMap((linkId) => node(ctx).removalsPending({ linkId }));
  if (!pending.length) return;
  const n = pending.length, one = n === 1;
  const [now, then, go] = clearing ? ["clearing the profile", "clear it then", "clear it"] : ["removing the chat", "remove the chat then", "remove it"];
  throw new CliError("confirm", `${one ? "A message you deleted for everyone has" : `${n} messages you deleted for everyone have`} not reached the contact yet: ${now} now leaves ${one ? "it" : "them"} on their device. Keep this profile online until the contact is reachable (ghostly daemon --detach) and ${then}, or pass --force (force: true over the socket) to ${go} now`, { messages: pending });
}

/**
 * Stages a one-shot `group join` stops waiting at. The link was replaced: knocking again does not get in. The group
 * has no room yet (`full`, or `blocked` while it waits for every member's app to take more than eight): the engine
 * goes on knocking until there is room, which a minute's wait seldom sees, so it says that the knock goes on only
 * while the profile runs.
 */
const NO_ROOM: Record<string, string> = {
  full: "No room yet: the group is full",
  blocked: "No room yet: the group waits for every member's app to take more than eight members",
};
const JOIN_STOPS = new Set(["replaced", ...Object.keys(NO_ROOM)]);
/** How long a one-shot `group join` waits to be let in: as long as a one-shot `invite join` waits to pair. */
const ONE_SHOT_JOIN_S = 60;
/** A replaced link never lets it in: the next step is a new link, not a daemon. */
const REPLACED = "This link was replaced or turned off: ask someone in the group for the current link, then ghostly group join <link>";

/**
 * A one-shot `group join` waits to be let in, as a one-shot invite join waits to pair: a member's app lets the joiner
 * in only while its knocks go on, and they stop when the command leaves. It left at once with `{"group": id}` and exit
 * 0, in 0.5 s, the admin online: the group stayed an invitation at "knocking" and nothing said a daemon had to run for
 * the knock to be answered. The answer says whether it is in and at what stage it waits, and what to do when it is not.
 * A contact's invitation to the group keeps its place and the link is only kept beside it: nothing knocks, so it
 * answers at once. Not accepted, only `group accept` moves it; accepted, only its welcome does, over the contact's chat.
 * In a group under the link's id already (`held`, before the join), the link is only kept beside it unless it is this
 * profile's own group's (the engine's `joinByLink`): nothing knocks, and it answered `"joined": true` for a link whose
 * group it never joined, with a second group waiting under the id that only `group show`'s `others` said.
 * Through a daemon the knock goes on after the answer, so it waits for nothing; it answered `{"group": id}` only, with
 * neither whether it was in nor a word about a link only kept beside a group held.
 */
async function letIn(ctx: ApiContext, groupId: string, link: string, held: GroupView | undefined): Promise<Record<string, unknown>> {
  const seen = (s: EngineState) => s.groups.find((g) => g.id === groupId);
  const id = shellWord(groupId, groupId);
  const invited = seen(state(ctx))?.invitation;
  if (invited && !invited.viaLink && !invited.takenBack) {
    const who = invited.contact || "a contact";
    if (!invited.accepted) return { group: groupId, joined: false, stage: null, warning: `Not in yet: ${who} invited you to this group and the invitation waits for your answer. Accept it: ghostly group accept ${id}` };
    return { group: groupId, joined: false, stage: null, warning: `Not in yet: you accepted ${who}'s invitation to this group, and its welcome has not arrived; the link was kept beside it, and knocks nowhere. The welcome arrives only while this profile is running: keep it running (ghostly daemon --detach), then ghostly group show ${id}` };
  }
  const opened = decodeGroupEntryLink(link);
  const own = held?.entryLink ? decodeGroupEntryLink(held.entryLink) : null;
  if (held?.status === "active" && opened && own?.host !== opened.host) {
    const kept = seen(state(ctx))?.others?.some((o) => "link" in o && decodeGroupEntryLink(o.link)?.host === opened.host);
    const pick = `keep the one you are in (ghostly engine keepGroup '{"groupId":"${groupId}"}') or take the link's instead, which leaves the one you are in and deletes its history on this device (ghostly engine switchGroup '{"groupId":"${groupId}","to":"<its link, from group show --show-secret>"}' --yes)`;
    return { group: groupId, joined: false, stage: null, warning: kept
      ? `Not joined: you are in a group under this link's id already, and only a group's welcome says whose a link is, so the link was kept beside that group and knocks nowhere. ghostly group show ${id} lists it under "others": ${pick}`
      : `Not joined: you are in a group under this link's id already, and as many other groups as are kept already wait beside it to be picked, so the link was not kept. ghostly group show ${id} lists them under "others": ${pick}, then open the link again` };
  }
  if (ctx.mode !== "one-shot") {
    const now = seen(state(ctx));
    const joined = now?.status === "active", stage = now?.invitation?.stage ?? null;
    if (joined || !now?.invitation?.viaLink) return { group: groupId, joined, stage };
    if (stage === "replaced") return { group: groupId, joined, stage, warning: REPLACED };
    // Not in yet, it named no way to follow the knock, as the one-shot's warning does.
    return { group: groupId, joined, stage, warning: `Not in yet: the daemon goes on knocking at the group's link until a member's app lets you in: ghostly group show ${id} follows it, ghostly group decline ${id} stops it` };
  }
  const done = (g: GroupView | undefined) => !g || g.status === "active" || JOIN_STOPS.has(g.invitation?.stage ?? "");
  const group = await waitForState(ctx, (s) => { const g = seen(s); return done(g) ? { g } : undefined; }, ONE_SHOT_JOIN_S * 1000, `group ${groupId} to let this profile in`)
    .then(({ g }) => g, (error: unknown) => { if (error instanceof CliError && error.code === "timeout") return seen(state(ctx)); throw error; });
  const joined = group?.status === "active", stage = group?.invitation?.stage ?? null;
  if (joined || !group) return { group: groupId, joined, stage };
  if (stage === "replaced") return { group: groupId, joined, stage, warning: REPLACED };
  const show = `keep it running (ghostly daemon --detach), then ghostly group show ${shellWord(groupId, groupId)}`;
  const full = stage === "full" ? group.invitation?.full : undefined;
  const noRoom = stage ? NO_ROOM[stage] : undefined;
  if (noRoom) return { group: groupId, joined, stage, warning: `${noRoom}${full ? ` (${full.n} of ${full.max} members)` : ""}. Your app goes on knocking only while this profile is running, and gets in when there is room: ${show}` };
  if (stage === "admitted") return { group: groupId, joined, stage, warning: `Not in yet: a member's app let you in, and the group's welcome has not finished arriving. It arrives only while this profile is running: ${show}` };
  return { group: groupId, joined, stage, warning: `Not in yet: no member's app has let you in. A member's app lets you in only while this profile is running: ${show}` };
}

/**
 * Why a text that waits will not go by itself, or undefined (waitNotice.ts `dhtOnlyNote`). This side's DHT only that is
 * a hold (`chat disconnect --hold`) is read from `ctx`'s profile; without it, as a DHT only chosen.
 */
function dhtOnlyWait(link: LinkView, text: string, ref: string, ctx?: ApiContext): string | undefined {
  return dhtOnlyNote(dhtOnlyOf(link, ctx), text, ref);
}

/** Where `link` stands on the DHT only (waitNotice.ts `DhtOnly`): this side's choice or hold, read from `ctx`'s profile. */
function dhtOnlyOf(link: LinkView, ctx?: ApiContext): DhtOnly {
  const mine = link.deliveryMode === "dht";
  return { mine, theirs: link.dhtDelivery?.peerMode === "dht", heldUntil: mine && ctx ? holdEnds(ctx, link.id) : null, oneShot: ctx?.mode === "one-shot" };
}

/**
 * Why my pin (or unpin) in a 1:1 chat does not go by itself, or undefined (waitNotice.ts `pinWaitsNote`): the chat is
 * on the DHT only, and a pin goes on a live session only. Read as the chat is now: the contact's choice may have come
 * since, or the chat left the DHT only. A chat nobody joined says that instead (`keptForJoin`, `goesOn`).
 */
function pinWaitsLive(ctx: ApiContext, linkId: string, ref: string, remove: boolean): string | undefined {
  const link = state(ctx).links.find((l) => l.id === linkId);
  return link && !nobodyJoined(link) ? pinWaitsNote(dhtOnlyOf(link, ctx), ref, remove) : undefined;
}

/**
 * A `--wait sent|delivered` on a text `dhtOnlyWait` holds back, ended short (its timeout, the daemon's stop): it said the
 * text still goes by itself, or with this profile's next command, which it does not while the chat stays on the DHT
 * only. It says why instead, with the note in `details.note` too; same code and exit. Read again at the end: a chat
 * taken off DHT only meanwhile keeps the usual words.
 */
function dhtOnlyTimeout(ctx: ApiContext, chat: string, text: string, ref: string, ms: number, error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== "timeout" || error.details?.delivery !== "waiting") return error;
  const link = state(ctx).links.find((l) => l.id === chat);
  const note = link && dhtOnlyWait(link, text, ref, ctx);
  return note ? new CliError("timeout", `${ended(ctx, ms)}: the message is waiting. ${note}`, { ...error.details, note }) : error;
}

/**
 * What keeps `link` off a live session, or undefined: a chat on DHT only opens none (WISP 100: no app dials it). A hold
 * of this side's (`chat disconnect --hold`) ends by itself (`held`: when), unless the contact's choice keeps it there
 * too; this side's choice or the contact's is `chat connect`'s refusal (apiKit `dhtOnly`), in its words.
 */
function offLive(ctx: ApiContext, link: LinkView): { held: number } | { refusal: CliError } | undefined {
  const held = link.deliveryMode === "dht" && link.dhtDelivery?.peerMode !== "dht" ? holdEnds(ctx, link.id) : null;
  if (held !== null) return { held };
  try { dhtOnly(link); } catch (error) { if (error instanceof CliError) return { refusal: error }; throw error; }
  return undefined;
}

/**
 * A `chat wait --until live` that timed out on a chat on DHT only: it could never go live, and its timeout read as a
 * slow network, so a script waited again. Said with why and what ends it, in `chat connect`'s words; same code, exit
 * and fields. Read as the chat is at the end: one taken off DHT only meanwhile keeps the usual words.
 */
function liveNeverCame(ctx: ApiContext, linkId: string, ref: string, error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== "timeout" || error.details) return error;
  const link = state(ctx).links.find((l) => l.id === linkId);
  const off = link && offLive(ctx, link);
  if (!off) return error;
  const why = "held" in off ? heldWords(off.held, ref, "it goes live", ctx.mode === "one-shot") : off.refusal.message;
  return new CliError("timeout", `${error.message}. ${why.charAt(0).toUpperCase()}${why.slice(1)}`);
}

const METHODS: Record<string, Method> = {
  ...WALLET_METHODS,
  ...FILE_METHODS,
  ...STATUS_CARD_METHODS,
  ...BUTTON_METHODS,
  ...GROUP_ADMIN_METHODS,
  ...IDENTITY_METHODS,
  ...X401_METHODS,
  ...SERVICE_METHODS,
  ...BACKUP_METHODS,
  ...CALL_METHODS,
  ...APP_SERVE_METHODS,
  ...APP_CHAT_METHODS,

  async status(ctx) {
    const s = state(ctx);
    // A daemon's: how each relay is doing and where its last read went, as the apps' connection panel says. With every
    // relay down, its status read as with them all fine. A one-shot asked none of them.
    const seen = ctx.mode === "daemon" ? s.transport.discovery : undefined;
    return {
      version: ctx.version, profile: ctx.runtime.paths.name, mode: ctx.mode, pid: process.pid,
      online: s.settings.online, name: s.settings.nick || null, webrtc: ctx.runtime.webrtc, calls: ctx.runtime.callsUnavailable === null,
      chats: s.links.length, live: s.links.filter(isLive).length, groups: s.groups.length,
      discovery: { protocol: s.transport.protocol, relays: s.transport.relays, ...(seen && { health: seen.relays, via: seen.path?.via ?? null }) },
      events: { lastSeq: ctx.hub.lastSeq },
      // A listen running the profile: `daemon stop` and `restart` end it too, as their answers say.
      ...(ctx.listen && { listen: true }),
    };
  },

  /**
   * This profile's status (WISP 401 § Presence and status), said to every paired contact whose app offers `status/1`:
   * at once on a live session, else on each chat's next one. A new one replaces the one before, whole.
   */
  async "status.get"(ctx) {
    return statusJson(node(ctx).getOwnStatus().status);
  },
  async "status.set"(ctx, params) {
    const until = params.until === undefined ? undefined : num(params, "until", 0, { min: 1, whole: true });
    const status = checkOwnStatus({ text: str(params, "text"), emoji: str(params, "emoji"), availability: str(params, "availability"), until }, (field) => field, "bad_request");
    // Every contact reads it, as the name they see.
    guardText(status.text, bool(params, "force"), "status", "set it");
    await node(ctx).setOwnStatus({ status });
    return statusJson(node(ctx).getOwnStatus().status);
  },
  async "status.clear"(ctx) {
    await node(ctx).clearOwnStatus();
    return statusJson(node(ctx).getOwnStatus().status);
  },

  async "profile.get"(ctx) {
    const settings = settingsOf(ctx);
    return { profile: ctx.runtime.paths.name, name: settings.nick || null, shareProfile: settings.shareProfile !== false, picture: !!settings.avatar, online: settings.online };
  },
  async "profile.set"(ctx, params) {
    const patch: Partial<Settings> = {};
    if (params.name !== undefined) patch.nick = checkShownName(params.name);
    // Every contact reads it, as a message's text.
    guardText(patch.nick, bool(params, "force"), "name", "set it");
    if (params.shareProfile !== undefined) patch.shareProfile = bool(params, "shareProfile");
    await node(ctx).updateSettings({ settings: patch });
    return METHODS["profile.get"](ctx, {});
  },

  async "settings.get"(ctx, params) {
    return redactSettings(settingsInEffect(settingsOf(ctx)), bool(params, "showSecret"));
  },
  async "settings.set"(ctx, params) {
    const patch: Record<string, unknown> = {};
    let warning: string | undefined;
    for (const [key, value] of Object.entries(params)) {
      if (key === "force") continue;
      // The table's own keys only: every object has `constructor` and `toString`, which are no settings.
      const kind = Object.hasOwn(SETTABLE, key) ? SETTABLE[key] : undefined;
      // The app's "Also use Pkarr relays": the CLI reads the relays first whatever it says (README § Network), and a
      // false taken with exit 0 changed nothing (bug hunt, 2026-10-19).
      if (key === "readRelays") throw new CliError("bad_request", "readRelays is not a setting the CLI follows: it reads the Pkarr relays first, so a contact on the web app (relays only) is found, and the Mainline DHT when every relay fails");
      if (!kind) throw new CliError("bad_request", `${key} is not a setting the CLI changes (${Object.keys(SETTABLE).join(", ")})`);
      if (kind === "strings" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) throw new CliError("bad_request", `${key} must be a list of strings`);
      if (kind === "string" && typeof value !== "string") throw new CliError("bad_request", `${key} must be a string`);
      if (kind === "boolean" && typeof value !== "boolean") throw new CliError("bad_request", `${key} must be true or false`);
      // The engine says "Enter at least one relay address" for any list it can't use (node.ts `updateSettings`): the
      // address given is named here, in the app's Settings words; an empty list stays the engine's to refuse.
      if (key === "relays" && (value as string[]).length && !(value as string[]).some(normalizeRelayUrl)) {
        throw relayRefused(new Error(relayUrlProblem((value as string[])[0]) ?? ""), { relays: value });
      }
      // The name contacts see: `profile set --name`'s rule.
      if (key === "nick") { patch.nick = checkShownName(value, key); guardText(patch.nick, bool(params, "force"), "nick", "set it"); continue; }
      if (kind === "ice") {
        if (!(Array.isArray(value) && value.every((v) => v && typeof v === "object"))) throw new CliError("bad_request", `${key} must be a list of ICE servers`);
        // WebRTC's own form (`urls` a list) is taken; a server without urls is said here, not as the engine's TypeError.
        const servers = value.map(iceServerSetting);
        for (const server of servers) { const problem = iceServerProblem(server); if (problem) throw new CliError("bad_request", `${key}: ${problem}`); }
        patch[key] = servers;
        // libdatachannel (libjuice) skips TURN over TCP and TLS without a word; the apps' browsers use them, so they stay.
        const unused = servers.flatMap((server) => server.urls.split(/[\s,]+/)).filter((url) => /^turns:|\?transport=tcp$/i.test(url));
        if (unused.length) warning = `The CLI reaches TURN over UDP only: it does not use ${unused.join(", ")} (the apps do). Add a turn: server over UDP for the CLI`;
        continue;
      }
      patch[key] = value;
    }
    await node(ctx).updateSettings({ settings: patch }).catch((error: unknown) => { throw relayRefused(error, patch); });
    return { ...redactSettings(settingsInEffect(settingsOf(ctx))), ...(warning ? { warning } : {}) };
  },

  async "invite.create"(ctx, params) {
    const label = chatName(params, "label");
    const { linkId, inviteCode } = await node(ctx).createLink();
    if (label) await node(ctx).renameLink({ linkId, label });
    // Native listeners start for the chat on screen (or a paired one): a new invite is the chat a bot waits on.
    showUntilPaired(ctx, linkId);
    // Its first records must be out before a one-shot leaves. A daemon publishes them later too: it answers at once when
    // the relays' request budget holds them back (a few invites in a minute), and says when they go.
    const progressOf = (s: EngineState) => s.links.find((l) => l.id === linkId)?.pairingProgress;
    const progress = await waitForState(ctx, (s) => { const p = progressOf(s); return p && (p.stage !== "publishing" || (ctx.mode === "daemon" && p.relayWaitUntil)) ? p : undefined; }, 20_000, "the invite to be published")
      .catch(() => progressOf(state(ctx)));
    const published = !!progress && progress.stage !== "publishing" && progress.reason !== "publish";
    const answer = { chat: linkId, invite: inviteCode, link: inviteLink(inviteCode), published };
    if (published) return answer;
    // Not out yet is not lost: the link works, so nobody should make another. Said here, not only in `chat show`.
    const waitUntil = progress?.relayWaitUntil;
    return {
      ...answer,
      ...(waitUntil !== undefined && { retryInMs: Math.max(0, waitUntil - Date.now()) }),
      ...(progress?.detail && { reason: inviteNotOut(progress.detail) }),
      note: "The invite is good: it goes out by itself once a relay answers, while a daemon runs for this profile",
    };
  },
  async "invite.join"(ctx, params) {
    let invite = str(params, "invite", true).trim();
    const label = chatName(params, "label");
    const hash = invite.indexOf("#");
    if (/^https?:\/\//i.test(invite) && hash !== -1) invite = invite.slice(hash + 1);
    let linkId: string;
    try {
      ({ linkId } = await node(ctx).joinLink({ inviteCode: invite }));
    } catch (error) {
      // This profile's own invite: the sentence alone, and the chat that owns it as its own field, not the engine's tag
      // for its RPC clients ("own-invite <chat>: …").
      const own = ownInviteRefusal(error);
      if (own) throw new CliError("refused", "This is your own invite. Share it with a contact; they join with it.", own.linkId ? { chat: own.linkId } : undefined);
      const message = error instanceof Error ? error.message : String(error);
      if (/does not look like/i.test(message)) throw new CliError("bad_request", message);
      throw error;
    }
    if (label) await node(ctx).renameLink({ linkId, label });
    showUntilPaired(ctx, linkId);
    return { chat: linkId };
  },

  async "chat.list"(ctx, params) {
    const showSecret = bool(params, "showSecret");
    return { chats: state(ctx).links.map((link) => chatJson(link, showSecret)).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || b.createdAt - a.createdAt) };
  },
  async "chat.get"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group show");
    return { ...chatDetailsJson(link, bool(params, "showSecret")), heldUntil: holdOf(ctx, link.id) };
  },
  async "chat.history"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group history");
    return historyOf(ctx, link.id, params, async () => (m) => chatMessageJson(m, link));
  },
  async "chat.send"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group send", "[text...]");
    const text = str(params, "text", true);
    checkTextSize(text);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", `The text looks like ${secretWords(secret)}; send it with --force if you mean to`, { kind: secret.kind });
    }
    // A one-shot leaves with its process, so by default it stays until the text went out. To a chat whose invite nobody
    // took there is no one to send to: the text is kept and goes once they join. It sat 30 s, then answered `timeout`.
    const unjoined = nobodyJoined(link);
    const wait = oneOf(params, "wait", ["none", "sent", "delivered"] as const, ctx.mode === "one-shot" && !unjoined ? "sent" : "none");
    // Read before anything is sent, as `wait` is: a timeout refused after the send made a retry send it again.
    const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
    const replyTo = str(params, "reply");
    // Buttons under the text (WISP 406 · Message Buttons): the text is the question, and what older apps show.
    const card = buttonsCard(params);
    // A kept `typing --for` ends with the message (the engine says stop with it).
    endTyping(ctx, { linkId: link.id }, false);
    const result = await node(ctx).sendMessage({ linkId: link.id, text, ...(replyTo ? { replyTo } : {}), ...(card ? { card } : {}) });
    // A `--reply` to a message this chat does not have is not_found (exit 3), as `file send --reply` and `group send` say.
    if (result.error) {
      throw (replyTo && notHere(result.error, replyTo, { group: false, ref: str(params, "chat", true) }))
        || (/not in this chat|cannot be replied to/.test(result.error) ? new CliError("not_found", result.error) : new CliError(result.refused ? "refused" : "unavailable", dhtTooLong(ctx, link, result.error, "text", str(params, "chat", true))));
    }
    if (!result.messageId) throw new CliError("bad_request", "Nothing to send");
    let message = await node(ctx).getMessage(link.id, result.messageId);
    // Past the 256 bytes the DHT carries, in a chat on the DHT only: it waits for a live session, which comes only once
    // the chat leaves DHT only. A one-shot sat 30 s, then answered `timeout` saying it goes with the next command.
    const ref = str(params, "chat", true);
    const dhtOnly = message?.delivery === "waiting" ? dhtOnlyWait(link, text, ref, ctx) : undefined;
    // An explicit `--wait` still waits as asked, and a wait that ends short says that note, not that the text goes by itself.
    if (wait !== "none" && !(dhtOnly && params.wait === undefined)) {
      message = await waitForMessage(ctx, link.id, result.messageId, wait, ms).catch((error: unknown) => { throw dhtOnlyTimeout(ctx, link.id, text, ref, ms, error); });
    }
    return {
      chat: link.id, messageId: result.messageId, delivery: message?.delivery ?? null, ...(card ? { buttons: card.id, card, pressable: pressable(link) } : {}),
      ...(unjoined && message?.delivery === "waiting" && { note: `Nobody joined this chat yet: the message goes once they join${ctx.mode === "one-shot" ? " while this profile is online (`ghostly daemon --detach`)" : ""}` }),
      ...(dhtOnly && message?.delivery === "waiting" && { note: dhtOnly }),
    };
  },
  /**
   * WISP 400 § Edits: the whole new text of one of my texts in a 1:1 chat. It shows here at once and reaches the contact
   * once the chat is live and both apps offer edit/1; `--wait confirmed` waits for the contact to confirm it.
   */
  async "chat.edit"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group edit", "<message> <text...>");
    const messageId = str(params, "message", true);
    const text = str(params, "text", true);
    // Before the guard: it read megabytes whole (`edit --stdin`), holding the daemon, for the engine to refuse them after.
    checkTextSize(text);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", `The text looks like ${secretWords(secret)}; edit with --force if you mean to`, { kind: secret.kind });
    }
    const { wait, ms } = confirmWait(ctx, params, link.id);
    // The edit number before, as `group edit` reads it: the text the message already has makes no edit. Undefined for
    // a message named by its wire id (no row goes by it): then only a message never edited is known unchanged.
    const prior = await node(ctx).getMessage(link.id, messageId);
    const before = prior ? prior.edit?.seq ?? 0 : undefined;
    const result = await node(ctx).editMessage({ linkId: link.id, messageId, text });
    if (result.error) throw await editRefused(ctx, link.id, messageId, { group: false, ref: str(params, "chat", true) }, dhtTooLong(ctx, link, result.error, "edit", str(params, "chat", true)), result);
    const id = result.messageId ?? messageId;
    let message = await node(ctx).getMessage(link.id, id);
    const edits = message?.edit?.seq ?? 0;
    // It answered `edits` as before with no flag, so a script could not tell it from an edit that went.
    const unchanged = !!message && edits === (before ?? 0);
    if (wait === "confirmed" && message?.edit?.pending) message = await waitForEdit(ctx, link.id, id, ms);
    const confirmed = !!message && !message.edit?.pending;
    // Too long for the DHT packet as an edit: it waits for the live session (`note`), refused where none comes.
    return { chat: link.id, messageId: id, edits: message?.edit?.seq ?? 0, confirmed, ...(unchanged && { unchanged: true }), ...(!confirmed && result.note && { note: result.note }), ...(!confirmed && keptForJoin(ctx, link.id, "the edit")) };
  },
  /**
   * WISP 401 § Typing: said on the live session only, and a start only while `sendTyping` is on; it holds 6 s there.
   * `kind` (typing, recording, thinking) and `status` (a short line, e.g. "Transcribing your audio…") say what this
   * side is doing; a new one reaches the contact at once.
   * `for`: kept that many seconds (a one-shot stays that long once the chat is live, and stops when it is not live
   * within `ONE_SHOT_LIVE_GRACE_MS`), until a message to the chat or a stop.
   */
  async "chat.typing"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group typing");
    const typing = !bool(params, "stop");
    const { kind, status } = typingWord(params, typing);
    const word = { ...(kind !== "typing" ? { kind } : {}), ...(status ? { status } : {}) };
    const seconds = params.for === undefined ? 0 : num(params, "for", 0, { min: 1, max: 600 });
    if (!typing && seconds) throw new CliError("bad_request", "for keeps typing on: not with stop");
    endTyping(ctx, { linkId: link.id }, false);
    node(ctx).setTyping({ linkId: link.id, typing, ...word });
    const until = seconds ? Date.now() + seconds * 1000 : null;
    const kept = seconds ? keepTyping(ctx, { linkId: link.id }, seconds * 1000, word) : null;
    const open = (s: EngineState) => s.links.find((l) => l.id === link.id)?.dataLink === "open";
    const seen = kept && ctx.mode === "one-shot" ? await keepOneShot(ctx, { linkId: link.id }, kept, open) : true;
    // Ended with nobody to see it: off, as a stop answers.
    const on = typing && seen;
    const now = state(ctx);
    return {
      chat: link.id, typing: on, ...(on ? { kind } : {}), ...(on && status ? { status } : {}),
      live: open(now), sendTyping: now.settings.sendTyping !== false, ...(on && until ? { until } : {}),
      ...oneShotTypingNote(ctx, typing, !!kept, seen),
    };
  },
  /**
   * WISP 400 § Reactions: one emoji per person per message, a new one replaces mine; `remove` takes mine back.
   * `wait: confirmed` (a one-shot's default) stays until the contact confirmed it; `confirmed` says whether it has.
   */
  async "chat.react"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group react", "<message> <emoji>");
    const { wait, ms } = confirmWait(ctx, params, link.id);
    // A new reaction of mine is numbered past every one still waiting: it is confirmed once none past those is left.
    const before = Math.max(...node(ctx).chatUnconfirmed({ linkId: link.id }).reactions);
    const result = await react(ctx, link.id, params, { group: false, ref: str(params, "chat", true) });
    const pending = (left: { reactions: number[] }) => left.reactions.some((n) => n > before);
    if (wait === "confirmed") await waitForConfirmed(ctx, link.id, "reaction", pending, ms, { messageId: result.messageId, emoji: result.emoji });
    const confirmed = !pending(node(ctx).chatUnconfirmed({ linkId: link.id }));
    return { chat: link.id, ...result, confirmed, ...(!confirmed && keptForJoin(ctx, link.id, "the reaction")) };
  },
  /**
   * WISP 400 § Pinned message: one per chat or group, a new pin replaces it; `remove` unpins. In a community only the
   * admin pins. Answers the chat (or group) and the message now pinned (null once unpinned). In a 1:1 chat `wait:
   * confirmed` (a one-shot's default) stays until the contact confirmed it, and `confirmed` says whether it has. A
   * group has no receipts: `wait: sent` (a one-shot's default) stays until an edge took it, and `edges` and `sent` say
   * how many did, as for `group react`.
   */
  async "chat.pin"(ctx, params) {
    const target = chatOrGroup(ctx, str(params, "chat", true));
    const remove = bool(params, "remove"), messageId = remove ? undefined : str(params, "message", true);
    // --remove names no message (the chat has one pin): one given beside it was not read, so a bot that meant "unpin
    // X" unpinned whatever was pinned, X or not.
    if (remove && str(params, "message") !== undefined) throw new CliError("bad_request", "remove names no message: it unpins whatever is pinned (give no message)");
    if (target.group && params.wait === "confirmed") throw new CliError("bad_request", "A group has no receipts: wait confirmed is for a 1:1 chat (wait sent waits until a member's edge took it)");
    if (!target.group && params.wait === "sent") throw new CliError("bad_request", "wait sent is for a group: a 1:1 chat's pin waits with wait confirmed");
    const { wait, ms } = target.group
      ? { wait: oneOf(params, "wait", ["none", "sent"] as const, ctx.mode === "one-shot" ? "sent" : "none"), ms: num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000 }
      : confirmWait(ctx, params, target.linkId);
    const result = await node(ctx).pinMessage({ linkId: target.linkId, ...(messageId && { messageId }), remove });
    const gone = result.error && messageId ? notHere(result.error, messageId, { group: target.group, ref: str(params, "chat", true) }) : undefined;
    if (gone) throw gone;
    if (result.error) {
      const error = new CliError(result.refused || /Only the admin/.test(result.error) ? "refused" : /not in this (?:chat|group)|Nothing is pinned/.test(result.error) ? "not_found" : "bad_request", result.error);
      const group = target.group ? groupById(ctx, target.id) : undefined;
      throw group ? notInYetError(group, str(params, "chat", true), error) : error;
    }
    if (target.group) {
      // A one-shot leaves once its command is done, and its groups with it: what no edge took yet went nowhere.
      const n = result.n, pinned = remove ? null : messageId;
      const edges = !n ? 0 : wait === "sent" ? await waitForGroupFrame(ctx, target.id, messageId ?? "", { pin: n }, ms)
        : node(ctx).groupTaken({ groupId: target.id, messageId: messageId ?? "", pin: n });
      return { group: target.id, messageId: pinned, removed: remove, sent: edges > 0, edges };
    }
    // The chat's one pin of mine waiting for the contact is this one (none: the contact confirmed it already).
    const mine = node(ctx).chatUnconfirmed({ linkId: target.linkId }).pin;
    const pending = (left: { pin: number | null }) => mine !== null && left.pin === mine;
    const ref = str(params, "chat", true), pinned = remove ? null : messageId;
    const waitsLive = () => pinWaitsLive(ctx, target.linkId, ref, remove);
    if (wait === "confirmed") await waitForConfirmed(ctx, target.linkId, "pin", pending, ms, { messageId: pinned, removed: remove }, waitsLive);
    const confirmed = !pending(node(ctx).chatUnconfirmed({ linkId: target.linkId }));
    const note = confirmed ? undefined : keptForJoin(ctx, target.linkId, remove ? "the unpin" : "the pin").note ?? waitsLive();
    return { chat: target.id, messageId: pinned, removed: remove, confirmed, ...(note && { note }) };
  },
  /** Saved messages: a mark on a message of a chat or a group, kept for this profile on this device; nothing is sent. */
  async "saved.add"(ctx, params) {
    return saveMark(ctx, params, false);
  },
  async "saved.remove"(ctx, params) {
    return saveMark(ctx, params, true);
  },
  /** The saved messages under `saved`, the last saved first, each as it is now and named by its chat or group. */
  async "saved.list"(ctx) {
    const { links, groups } = state(ctx);
    const saved = await node(ctx).savedMessages();
    // A saved reply quotes its original as history gives it: per chat or group, one read per quoted original.
    const originals = new Map<string, Originals>();
    for (const linkId of new Set(saved.map((s) => s.message.linkId))) originals.set(linkId, await originalsNow(ctx, linkId, saved.flatMap((s) => (s.message.linkId === linkId ? [s.message] : []))));
    return {
      saved: saved.map(({ savedAt, message }) => {
        const checked = (json: MessageJson) => quoteChecked(json, message, originals.get(message.linkId)!);
        if (!message.linkId.startsWith("group:")) return { chat: message.linkId, savedAt, message: checked(chatMessageJson(message, links.find((l) => l.id === message.linkId))) };
        const id = message.linkId.slice("group:".length);
        return { group: id, savedAt, message: checked(groupMessageJson(message, groups.find((g) => g.id === id))) };
      }),
    };
  },
  /**
   * WISP 400 § Forwards: messages of a chat or a group sent on to up to 5 chats and groups, each as a new message of mine
   * that says it was forwarded (one hop more) and nothing of who wrote it. A file goes from the bytes here, never
   * fetched again; a group takes texts only. `wait: sent`: each text until it is on its way (a group's until an edge
   * took it), each file until its transfer is done. What a chat refused comes back per chat; any refusal fails the call.
   */
  async "chat.forward"(ctx, params) {
    const s = state(ctx);
    const from = chatOrGroup(ctx, str(params, "chat", true), s);
    // Each id once, and the engine's bounds before any row is read: one id given 50,000 times was read and guarded as
    // often (a minute of the daemon's thread) for the one message the engine forwarded.
    const messageIds = [...new Set(list(params, "messages"))];
    if (!messageIds.length) throw new CliError("bad_request", "Name the messages to forward (their ids, from history or an event)");
    if (messageIds.length > FORWARD_MESSAGES) throw new CliError("bad_request", `Forward at most ${FORWARD_MESSAGES} messages at once, not ${messageIds.length}`);
    // A chat or group named twice (by its name and its id too) is one of them, as the engine counts.
    const to: (ReturnType<typeof chatOrGroup> & { ref: string })[] = [];
    for (const ref of new Set(list(params, "to"))) {
      const target = chatOrGroup(ctx, ref, s);
      if (to.some((t) => t.linkId === target.linkId)) continue;
      if (to.length === FORWARD_TARGETS) throw new CliError("bad_request", `Forward to at most ${FORWARD_TARGETS} chats and groups at once`);
      to.push({ ...target, ref });
    }
    if (!to.length) throw new CliError("bad_request", "Forward to which chat? Name one or more with --to");
    // Each by its id here, one row each: never the whole history of the chat or group.
    const chosen: StoredMessage[] = [];
    for (const id of messageIds) {
      const message = await node(ctx).getMessage(from.linkId, id);
      if (!message) throw noMessage(id, { group: from.group, ref: str(params, "chat", true) });
      chosen.push(message);
    }
    if (!bool(params, "force")) for (const message of chosen) {
      const secret = message.file ? null : findSecret(message.text);
      if (secret) throw new CliError("confirm", `A message looks like ${secretWords(secret)}; forward it with --force if you mean to`, { kind: secret.kind, messageId: message.id });
    }
    const wait = oneOf(params, "wait", ["none", "sent"] as const, "none");
    // A one-shot leaves once its command is done, and its groups with it: a group's copy waits for an edge by default,
    // as `group send` does.
    const groupWait = params.wait === undefined && ctx.mode === "one-shot" ? "sent" : wait;
    const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
    let results;
    try { ({ results } = await node(ctx).forwardMessages({ linkId: from.linkId, messageIds, to: to.map((t) => t.linkId) })); }
    catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
    const out: { to: string; kind: "group" | "chat"; messageIds: string[]; sent: string[]; error: string | null; edges?: number; note?: string }[] =
      results.map((result, i) => ({ to: to[i]!.id, kind: to[i]!.group ? "group" as const : "chat" as const, messageIds: result.messageIds, sent: result.sent, error: result.error }));
    // A text past the 256 bytes the DHT carries, forwarded into a chat on the DHT only, waits as `send`'s does: the
    // chat's result says why in a `note`, and a `--wait sent` that ends short says it too. It said nothing, and the
    // timeout that the text still goes by itself.
    for (const [i, result] of out.entries()) {
      const link = to[i]!.group ? undefined : state(ctx).links.find((l) => l.id === to[i]!.id);
      // Its copies read only in a chat on the DHT only, by either side's choice.
      if (!link || (link.deliveryMode !== "dht" && link.dhtDelivery?.peerMode !== "dht")) continue;
      for (const messageId of result.messageIds) {
        const copy = await node(ctx).getMessage(link.id, messageId);
        if (copy && !copy.file && copy.delivery === "waiting") result.note ??= dhtOnlyWait(link, copy.text, to[i]!.ref);
      }
    }
    // A copy's wait that ends short (its time ran out, its delivery failed) ends the waits, not the answer: it threw
    // alone with that copy's id, every target's result and another's refusal lost, and a bot that sent again sent twice.
    let short: CliError | undefined;
    const waited = async <T>(wait: () => Promise<T>, now: () => T): Promise<T> => {
      if (short) return now();
      try { return await wait(); } catch (error) { short = asCliError(error); return now(); }
    };
    // A group's `edges`: how many took each of its copies so far (the fewest), as `group send` says it.
    for (const [i, result] of out.entries()) if (to[i]!.group) {
      let edges: number | undefined;
      for (const messageId of result.messageIds) {
        const taken = () => node(ctx).groupTaken({ groupId: to[i]!.id, messageId });
        const took = groupWait === "sent" ? await waited(() => waitForGroupFrame(ctx, to[i]!.id, messageId, undefined, ms), taken) : taken();
        edges = Math.min(edges ?? took, took);
      }
      result.edges = edges ?? 0;
    }
    if (wait === "sent") for (const [i, result] of out.entries()) for (const messageId of result.messageIds) {
      if (to[i]!.group) continue;
      await waited(async () => {
        const sent = await node(ctx).getMessage(to[i]!.id, messageId);
        if (sent?.file) await FILE_METHODS["file.wait"](ctx, { chat: to[i]!.id, file: sent.file.id, timeout: ms / 1000 });
        else await waitForMessage(ctx, to[i]!.id, messageId, "sent", ms).catch((error: unknown) => { throw dhtOnlyTimeout(ctx, to[i]!.id, sent?.text ?? "", to[i]!.ref, ms, error); });
      }, () => undefined);
    }
    // A refusal first, then what ended a wait: each with every target's result.
    const failed = out.filter((r) => r.error);
    if (failed.length) throw new CliError(failed.length === out.length ? "refused" : "engine", failed.map((r) => `${r.to}: ${r.error}`).join("; "), { from: from.id, results: out });
    if (short) throw new CliError(short.code, short.message, { ...short.details, from: from.id, results: out });
    return { from: from.id, results: out };
  },
  async "chat.retry"(ctx, params) {
    // A group has no failed message to send again: it stays in the group and goes when a member's edge opens.
    const link = notAGroup(ctx, params, () => chatOf(ctx, params), () => "a group's message is not sent again by hand, it goes by itself when a member's edge opens");
    const messageId = str(params, "message", true);
    const message = await node(ctx).getMessage(link.id, messageId);
    const place = { group: false, ref: str(params, "chat", true) };
    if (!message) throw noMessage(messageId, place);
    // Before, both answered done and nothing was sent: the engine sends again whatever id it is given.
    if (message.sender !== "me") throw noMessage(messageId, place, { whose: "of yours", tail: ": only your own messages are sent again" });
    if (message.delivery === "delivered") throw new CliError("refused", "Nothing to send again: it was delivered");
    await node(ctx).retryMessage({ linkId: link.id, messageId });
    return { chat: link.id, messageId };
  },
  // `--purge` folds the store even when the delete answers no (`foldsAnyway`): a message already gone, another's.
  "chat.delete": foldsAnyway(async (ctx, params) => {
    // `--purge`: what it said leaves the profile's folder before the answer (`purgeMessage`), and the answer says so.
    const purge = bool(params, "purge"), purged = purge ? { purged: true } : {};
    // For everyone (WISP 400 § Delete for everyone): a message of mine, in a chat or a group, gone from every device.
    if (bool(params, "everyone")) {
      const target = chatOrGroup(ctx, str(params, "chat", true));
      // A one-shot leaves once its command is done, and the removal with it: by default it stays until the contact has it,
      // or in a group (no receipts) until a member's edge took it.
      const wait = oneOf(params, "wait", ["none", "confirmed", "sent"] as const, ctx.mode !== "one-shot" ? "none" : target.group ? "sent" : "confirmed");
      if (target.group && wait === "confirmed") throw new CliError("bad_request", "A group has no receipts: --wait confirmed is for a chat (--wait sent waits until a member's edge took it)");
      if (!target.group && wait === "sent") throw new CliError("bad_request", "--wait sent is for a group: a chat's removal waits with --wait confirmed");
      const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
      const ref = str(params, "message", true);
      // Another's message the ref names (by its id or wire id), seen in the same reads that look for mine.
      let theirs: StoredMessage | undefined;
      const message = await messageOf(ctx, target.linkId, ref, (m) => {
        if (m.sender !== "me" && (m.id === ref || m.wireId === ref)) theirs ??= m;
        return m.sender === "me";
      });
      if (!message) throw deleteNotMine(ctx, target, ref, theirs, { group: target.group, ref: str(params, "chat", true) }, purge);
      const result = await node(ctx).removeMessage({ linkId: target.linkId, messageId: message.id });
      if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
      // Gone here at once: the fold need not wait for the contact or an edge.
      if (purge) await purgeMessage(ctx, message);
      // A wait that ends short: the message is gone here all the same (out of the folder with `--purge`), so its timeout
      // says so and names it as the answer would. The group's said "it stays in the group", as for an edit, and neither
      // said the purge ran: a script saw exit 4, and its retry was refused as "No message … of yours".
      const goneHere = async <T>(wait: () => Promise<T>, text?: string): Promise<T> => {
        try { return await wait(); } catch (error) {
          if (!(error instanceof CliError) || error.code !== "timeout") throw error;
          throw new CliError("timeout", text ?? error.message, { ...error.details, deleted: message.id, ...purged });
        }
      };
      // `messageId`, as every command that makes or changes a message names it; `deleted` kept for callers that read
      // it (agents#1582).
      if (target.group) {
        const e = result.e;
        const edges = !e ? 0 : wait === "sent"
          ? await goneHere(() => waitForGroupFrame(ctx, target.id, message.id, e, ms), `${ended(ctx, ms)}: the message is gone here and no member's edge took its removal yet (it goes when one opens). Its removal ${goesOn(ctx)}`)
          : node(ctx).groupTaken({ groupId: target.id, messageId: message.id, edit: e });
        return { group: target.id, messageId: message.id, deleted: message.id, everyone: true, sent: edges > 0, edges, ...purged };
      }
      if (wait === "confirmed") await goneHere(() => waitForRemoval(ctx, target.linkId, message.id, ms));
      return { chat: target.id, messageId: message.id, deleted: message.id, everyone: true, confirmed: !node(ctx).removalPending({ linkId: target.linkId, messageId: message.id }), ...purged };
    }
    // A group's message is deleted for everyone only (the apps forget none on one device): a group named without the
    // flag says so, with the command that takes it, not "No chat".
    // `message delete --everyone` takes a chat's name before a group's, and never takes a name shaped like a chat's id or
    // a contact's key as a group's: the command offered names the group by `group:` unless the name alone reaches it.
    const ref = str(params, "message") ?? "<message>", typed = str(params, "chat", true);
    const reachesGroup = (name: string) => { try { return "group" in findChatOrGroup(state(ctx).links, state(ctx).groups, name); } catch { return false; } };
    let link: ReturnType<typeof chatOf>;
    try {
      // `--purge` stays in the command offered: pasted without it, the text stayed in the profile's folder up to an hour.
      link = notAGroup(ctx, params, () => chatOf(ctx, params), (shown, id) => `ghostly message delete ${id === undefined || (groupPrefixed(typed) === null && reachesGroup(typed)) ? shown : shellWord(groupPrefixed(typed) === null ? `group:${typed}` : typed, `group:${id}`)} ${ref === "<message>" ? ref : shellWord(ref, "<message>")} --everyone${purge ? " --purge" : ""}${byItsId(id)}`);
    } catch (error) {
      // Another member's message: only its author deletes it, so the `--everyone` offered was then refused as not mine,
      // a second command to learn it cannot be deleted at all. A history that cannot be read keeps that hint.
      const group = error instanceof CliError ? error.details?.group : undefined;
      const theirs = typeof group === "string" && ref !== "<message>" ? await messageOf(ctx, `group:${group}`, ref).catch(() => undefined) : undefined;
      if (theirs && theirs.sender !== "me") throw new CliError("not_found", `${JSON.stringify(typed)} is a group, and ${JSON.stringify(ref)} is another member's message in it: only its author deletes a group's message, for everyone`, { group });
      throw error;
    }
    const messageId = str(params, "message", true);
    const message = await node(ctx).getMessage(link.id, messageId);
    if (!message) throw noMessage(messageId, { group: false, ref: str(params, "chat", true) });
    // A waiting text of mine is cancelled; one the outbox already handed to the link may be out, so the engine deletes it
    // for everyone instead, and `everyone` says so.
    const { everyone } = node(ctx).deleteMessage({ linkId: link.id, messageId });
    if (purge) await purgeMessage(ctx, message);
    return { chat: link.id, messageId, deleted: messageId, everyone, ...purged };
  }),
  /** A chat's or a group's (`group:<id>`, or its name) message, as the app's details show it; a group's said `No chat`. */
  async "chat.details"(ctx, params) {
    const target = chatOrGroup(ctx, str(params, "chat", true));
    const messageId = str(params, "message", true);
    const details = await node(ctx).messageDetails({ linkId: target.linkId, messageId });
    if (!details) throw noMessage(messageId, { group: target.group, ref: str(params, "chat", true) });
    return details;
  },
  async "chat.rename"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group rename", "<name...>");
    await node(ctx).renameLink({ linkId: link.id, label: chatName(params, "name") ?? "" });
    return chatJson(findChat(state(ctx).links, link.id));
  },
  async "chat.remove"(ctx, params) {
    const link = chatNotGroup(ctx, params, "group forget", "--yes");
    if (!bool(params, "yes")) throw new CliError("confirm", "Removing a chat deletes its keys and history on this device; pass --yes (yes: true over the socket) to go on");
    noCallOn(ctx, link.id, "remove the chat");
    if (!bool(params, "force")) noRemovalOnItsWay(ctx, [link.id]);
    await node(ctx).removeLink({ linkId: link.id });
    ctx.calls.forgetChat(link.id);
    ctx.groupAuto.forgetChat(link.id);
    await forgetHold(ctx, link.id);
    await closeServicesOf(ctx, link.peerPubKeyZ32);
    return { removed: link.id };
  },
  async "chat.transport"(ctx, params) {
    const link = chatNotGroupLink(ctx, params);
    const name = str(params, "transport", true);
    const transport = Object.hasOwn(TRANSPORT_NAMES, name) ? TRANSPORT_NAMES[name] : undefined;
    if (!transport) throw new CliError("bad_request", `transport must be one of auto, dht, webrtc, iroh, hyperdht`);
    if (transport === "dht") noCallOn(ctx, link.id, "put the chat on DHT only");
    else if (transport !== "auto") transportOffered(link, transport);
    await node(ctx).setChatTransport({ linkId: link.id, transport });
    // A choice made during a hold (`chat disconnect --hold`) ends it: its time running out takes nothing back.
    await releaseHold(ctx, link.id, "lifted", true);
    return chatDetailsJson(findChat(state(ctx).links, link.id));
  },
  /** Reconnects now; a chat held off its direct link (`chat disconnect --hold`) leaves the hold first. */
  async "chat.connect"(ctx, params) {
    const link = chatNotGroupLink(ctx, params);
    await releaseHold(ctx, link.id, "connect");
    inviteTaken(link);
    dhtOnly(findChat(state(ctx).links, link.id));
    await connectWithin(ctx, link, num(params, "timeout", CONNECT_MAX_SECONDS, { min: 1, max: CONNECT_MAX_SECONDS }) * 1000);
    return chatJson(findChat(state(ctx).links, link.id));
  },
  /**
   * Closes the live session; the contact's app may dial again at once. `hold` (minutes): the chat stays off its
   * direct link that long, on the DHT (its "DHT only" choice, taken back after); 0 ends a hold now.
   */
  async "chat.disconnect"(ctx, params) {
    const link = chatNotGroupLink(ctx, params);
    const minutes = params.hold === undefined ? undefined : num(params, "hold", 0, { min: 0, max: HOLD_MAX_MINUTES });
    // `--hold 0` still ends a hold, one an older version put on a waiting invite too.
    if (minutes !== 0) somebodyJoined(link);
    if (minutes === undefined) {
      node(ctx).disconnect({ linkId: link.id });
      return chatJson(findChat(state(ctx).links, link.id));
    }
    if (minutes > 0) noCallOn(ctx, link.id, "hold the chat");
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
    const link = chatNotGroupLink(ctx, params);
    const until = oneOf(params, "until", ["live", "text", "paired"] as const, "live");
    const ms = num(params, "timeout", 60, { min: 1, max: 86_400 }) * 1000;
    // The chat as the person named it, as the waiting notice says it (waitNotice.ts): its id read as another chat.
    const ref = str(params, "chat", true);
    const view = await waitForState(ctx, (s) => {
      const now = s.links.find((l) => l.id === link.id);
      if (!now) throw new CliError("not_found", `Chat ${link.id} was removed`);
      // Live: a session that exists now, never one remembered from the last run (`isLive`). Paired: the contact's key
      // kept (`peerParticipationKey`) is a fact of the chat, whether the contact is online now or not.
      const ok = until === "live" ? isLive(now)
        : until === "text" ? now.textDelivery === "stream" || now.textDelivery === "dht" || now.textDelivery === "hold"
        : !!now.peerParticipationKey || !!now.pairingProgress?.peerSeen || now.pairing?.status === "ready" || isLive(now);
      return ok ? now : undefined;
    }, ms, `chat ${ref} ${chatState(until).to}`).catch((error: unknown) => { throw until === "live" ? liveNeverCame(ctx, link.id, ref, error) : error; });
    return chatJson(view);
  },

  async "group.create"(ctx, params) {
    // As `group rename` checks it: a name a group cannot have is said here, before anything is made.
    const name = groupNameOf(params);
    // Every member reads it, and a community's anyone who opens its link.
    guardText(name, bool(params, "force"), "group's name", "create it");
    const profile = oneOf(params, "profile", ["community", "mesh"] as const, "community");
    const { groupId } = await node(ctx).createGroup({ name, profile });
    let link: string | null = null;
    if (profile === "community") ({ link } = await node(ctx).enableGroupLink({ groupId }));
    return withUrl(groupId, link);
  },
  async "group.join"(ctx, params) {
    let groupId: string;
    const link = str(params, "link", true);
    // What was held before the join: a group already active under the link's id only gets the link noted beside it.
    const before = state(ctx).groups;
    try {
      ({ groupId } = await node(ctx).joinGroupByLink({ link }));
    } catch (error) {
      // Not a link to a group at all: the caller's input, as `invite join` answers a word that is no invite.
      if (error instanceof Error && error.message === "This is not a link to a group") throw new CliError("bad_request", error.message);
      throw joinRefused(link, error);
    }
    return letIn(ctx, groupId, link, before.find((g) => g.id === groupId));
  },
  async "group.list"(ctx, params) {
    const showSecret = bool(params, "showSecret");
    return { groups: state(ctx).groups.map((g) => groupJson(g, showSecret)).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)), autoJoin: ctx.groupAuto.get() };
  },
  /** Invitations over the chats named accepted by the daemon itself (`group auto on --from`); no argument: the setting. */
  async "group.auto"(ctx, params) {
    const on = params.on === undefined ? undefined : bool(params, "on");
    // The chats go with on: true, as `group auto --from` refuses them without on: before, from with on: false dropped
    // every chat on the list, and from alone only read the setting, each without a word.
    if (on !== true && list(params, "from").length > 0) throw new CliError("bad_request", "from goes with on: true");
    if (on === undefined) return { autoJoin: ctx.groupAuto.get() };
    return { autoJoin: ctx.groupAuto.set({ on, from: list(params, "from") }) };
  },
  async "group.get"(ctx, params) {
    return groupJson(groupOf(ctx, params, "chat show <chat>"), bool(params, "showSecret"));
  },
  async "group.history"(ctx, params) {
    const group = groupOf(ctx, params, "chat history <chat>");
    return historyOf(ctx, `group:${group.id}`, params, async (page) => {
      const twins = await groupPayTwinsOf(ctx, group, page);
      return (m) => groupMessageJson(m, group, twins.get(m.id));
    });
  },
  async "group.send"(ctx, params) {
    const group = groupOf(ctx, params, "send <chat> [text...]");
    const text = str(params, "text", true);
    checkTextSize(text);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", `The text looks like ${secretWords(secret)}; send it with --force if you mean to`, { kind: secret.kind });
    }
    const mentions = mentionsFor(text, list(params, "mentions"), group, () => settingsOf(ctx).nick, str(params, "group", true));
    const replyTo = str(params, "reply");
    const wait = oneOf(params, "wait", ["none", "sent"] as const, "none");
    const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
    const card = buttonsCard(params);
    // A kept `group typing --for` ends with the message (the engine says stop with it).
    endTyping(ctx, { groupId: group.id }, false);
    const result = await node(ctx).sendGroupMessage({ groupId: group.id, text, ...(mentions.length ? { mentions } : {}), ...(replyTo ? { replyTo } : {}), ...(card ? { card } : {}) });
    // Not a member (removed, say): refused, and nothing was sent. Anything else by what a bot can do about it.
    // A `--reply` the group lacks says "group": the engine's line says "chat".
    if (result.error) throw (replyTo && notHere(result.error, replyTo, { group: true, ref: str(params, "group", true) }))
      || notInYetError(group, str(params, "group", true), result.refused ? new CliError("refused", result.error) : groupSendRefused(result.error));
    const messageId = result.messageId ?? null;
    // `edges`: how many took it so far (none yet is not an error: it goes when one opens). `sent`: whether one did.
    // Before 2026-10-02 `sent` was always true, also for a message no edge had taken.
    const edges = messageId ? (wait === "sent" ? await waitForGroupFrame(ctx, group.id, messageId, undefined, ms) : node(ctx).groupTaken({ groupId: group.id, messageId })) : 0;
    return {
      group: group.id, messageId, sent: edges > 0, edges, ...(card ? { buttons: card.id, card } : {}),
      ...(messageId && nobodyElseIn(ctx, group.id) ? { note: "Nobody else is in this group: nobody gets this message, not even someone who joins later" } : {}),
    };
  },
  /**
   * WISP 902 § Edits: the whole new text of one of my messages in a group. It shows here at once and goes to the members
   * (a private group's over the edges that are up, the others when theirs open; a community's through the group).
   * `mentions`: members the new text names beyond those the message named. `sent`: whether an edge took it, as for group send.
   */
  async "group.edit"(ctx, params) {
    const group = groupOf(ctx, params, "edit <chat> <message> <text...>");
    const messageId = str(params, "message", true);
    const text = str(params, "text", true);
    checkTextSize(text);
    if (!bool(params, "force")) {
      const secret = findSecret(text);
      if (secret) throw new CliError("confirm", `The text looks like ${secretWords(secret)}; edit with --force if you mean to`, { kind: secret.kind });
    }
    const mentions = mentionsFor(text, list(params, "mentions"), group, () => settingsOf(ctx).nick, str(params, "group", true));
    const wait = oneOf(params, "wait", ["none", "sent"] as const, "none");
    const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
    const linkId = `group:${group.id}`;
    const before = (await node(ctx).getMessage(linkId, messageId))?.edit?.seq ?? 0;
    const result = await node(ctx).editMessage({ linkId, messageId, text, ...(mentions.length ? { mentions } : {}) });
    if (result.error) throw await editRefused(ctx, linkId, messageId, { group: true, ref: str(params, "group", true) }, result.error, result);
    const message = await node(ctx).getMessage(linkId, messageId);
    const edits = message?.edit?.seq ?? 0;
    // The text the message already has: no edit was made and nothing went. It answered `sent: true` before, for a
    // message never edited, as if an edit had gone.
    if (edits === before) return { group: group.id, messageId, edits, sent: false, edges: 0, unchanged: true };
    // An edit waiting for the pace is not said yet: `--wait sent` waits for that too, then for an edge to take it.
    const edges = !edits ? 0 : wait === "sent" ? await waitForGroupFrame(ctx, group.id, messageId, edits, ms)
      : node(ctx).groupTaken({ groupId: group.id, messageId, edit: edits });
    // Before 2026-11-01 `sent` was also true for an edit no edge had taken, once it no longer waited for the pace.
    return { group: group.id, messageId, edits, sent: edges > 0, edges };
  },
  /**
   * WISP 400 § Reactions in a group, which has no receipts: `edges` says how many took it, `sent` whether one did.
   * `wait: sent` (a one-shot's default: what is not said yet leaves with the process) stays until an edge took it.
   */
  async "group.react"(ctx, params) {
    const group = groupOf(ctx, params, "react <chat> <message> <emoji>");
    const wait = oneOf(params, "wait", ["none", "sent"] as const, ctx.mode === "one-shot" ? "sent" : "none");
    const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
    const ref = str(params, "group", true);
    const { n, ...said } = await react(ctx, `group:${group.id}`, params, { group: true, ref }).catch((error) => { throw error instanceof CliError ? notInYetError(group, ref, error) : error; });
    const edges = !n ? 0 : wait === "sent" ? await waitForGroupFrame(ctx, group.id, said.messageId, { reaction: n }, ms)
      : node(ctx).groupTaken({ groupId: group.id, messageId: said.messageId, reaction: n });
    return { group: group.id, ...said, sent: edges > 0, edges };
  },
  /**
   * WISP 902 · Group Mesh § Typing: `chat.typing` in a private group, said on the edges that are open (`reached`: to
   * how many members), with the same kinds, status rules, 6 s hold and `for`. A community does not carry typing yet.
   */
  async "group.typing"(ctx, params) {
    const group = groupOf(ctx, params, "typing <chat>");
    if (group.profile !== "mesh") throw new CliError("unavailable", "A community does not carry typing yet: only a private group does");
    const typing = !bool(params, "stop");
    const { kind, status } = typingWord(params, typing);
    const word = { ...(kind !== "typing" ? { kind } : {}), ...(status ? { status } : {}) };
    const seconds = params.for === undefined ? 0 : num(params, "for", 0, { min: 1, max: 600 });
    if (!typing && seconds) throw new CliError("bad_request", "for keeps typing on: not with stop");
    // Removed or gone, as `group send` says it: `refused`, with the group's reason; not in yet, with the next step.
    if (typing && group.status !== "active") throw new CliError("refused", group.statusReason ?? notInYet(group, str(params, "group", true)) ?? "You are not in this group");
    const target = { groupId: group.id };
    endTyping(ctx, target, false);
    sayTyping(ctx, target, typing, word);
    const until = seconds ? Date.now() + seconds * 1000 : null;
    const kept = seconds ? keepTyping(ctx, target, seconds * 1000, word) : null;
    const reached = (now: GroupView | undefined) => (now ?? group).members.filter((m) => !m.me && m.online && !m.viaHub).length;
    const seen = kept && ctx.mode === "one-shot" ? await keepOneShot(ctx, target, kept, (s) => reached(s.groups.find((g) => g.id === group.id)) > 0) : true;
    const on = typing && seen;
    return {
      group: group.id, typing: on, ...(on ? { kind } : {}), ...(on && status ? { status } : {}),
      reached: reached(groupById(ctx, group.id)), sendTyping: settingsOf(ctx).sendTyping !== false, ...(on && until ? { until } : {}),
      ...oneShotTypingNote(ctx, typing, !!kept, seen),
    };
  },
  async "group.leave"(ctx, params) {
    const group = groupOf(ctx, params);
    if (!bool(params, "yes")) throw new CliError("confirm", "Leaving a group deletes its history and files on this device; pass --yes (yes: true over the socket) to go on");
    const ref = str(params, "group", true);
    const { admin } = await node(ctx).leaveGroup({ groupId: group.id }).catch((error) => { throw leaveRefused(group, ref, error); });
    // The member who became the admin, named from the roster read before leaving: the group is gone from the state now.
    const next = admin ? group.members.find((m) => m.key === admin) : undefined;
    return { left: group.id, ...(admin ? { admin: { key: admin, name: next?.nick ?? null } } : {}) };
  },
  async "group.forget"(ctx, params) {
    const group = groupOf(ctx, params, "chat remove <chat> --yes");
    if (!bool(params, "yes")) throw new CliError("confirm", "Forgetting a group deletes its history on this device; pass --yes (yes: true over the socket) to go on");
    await node(ctx).forgetGroup({ groupId: group.id });
    return { forgotten: group.id };
  },
  async "group.accept"(ctx, params) {
    const group = groupOf(ctx, params);
    // Nothing to accept, said with why: before, a community this profile is in or was removed from answered done, exit
    // 0 (the engine's knock again does nothing there), and a private group "No invitation to accept".
    if (!group.invitation) throw new CliError("refused", `${outOf(group) ?? `You are in ${group.name} already`}: there is no invitation to accept`);
    await node(ctx).acceptGroupInvitation({ groupId: group.id });
    return { group: group.id };
  },
  async "group.decline"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).declineGroupInvitation({ groupId: group.id });
    return { group: group.id };
  },

  async "events.replay"(ctx, params) {
    return { events: ctx.hub.replay(sinceSeq(params, 0)), lastSeq: ctx.hub.lastSeq };
  },

  async "daemon.stop"(ctx) {
    if (ctx.mode !== "daemon" || !ctx.stop) throw new CliError("unavailable", "No daemon runs this profile");
    setTimeout(() => ctx.stop!(), 10);
    return { stopping: true, pid: process.pid, ...(ctx.listen && { listen: true }) };
  },

  async "engine.call"(ctx, params) {
    const method = str(params, "method", true);
    if (!ENGINE_METHODS.includes(method) && !ENGINE_READS.includes(method)) throw new CliError("not_found", `The engine has no call ${method}`);
    const raw = params.params;
    if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) throw new CliError("bad_request", "params must be an object");
    const args = raw as Params | undefined;
    // "Hide my IP from contacts" (`relayOnly`, WISP 100 § Relay only) is the apps' switch in Settings, Network, not the
    // CLI's yet: its WebRTC chat links (node-datachannel) still check from this machine's own sockets under the relay
    // policy, as its calls did (they are refused while it is on). Nobody turns it on through here until they keep to
    // the relay; turning it off stays possible, for a profile an older CLI (whose engine took any key) turned it on in.
    if (method === "updateSettings" && args?.settings && typeof args.settings === "object" && "relayOnly" in args.settings && (args.settings as Params).relayOnly !== false) {
      throw new CliError("bad_request", "relayOnly is not a setting yet: Hide my IP from contacts comes in a later release");
    }
    // Real money moves only on an explicit confirmation of this call (WISP 1100 § Mainnet).
    if (args && "confirmedReal" in args && !bool(params, "confirmReal")) {
      throw new CliError("confirm", `${method} spends real money: pass --confirm-real (confirmReal: true over the socket) to confirm it`);
    }
    const deletes = DESTRUCTIVE_CALLS.get(method);
    if (deletes && !bool(params, "yes")) throw new CliError("confirm", `${method} ${deletes}; pass --yes (yes: true over the socket) to go on`);
    if (method === "clearProfileData") return clearProfile(ctx, bool(params, "force"));
    // A call given less than it takes failed with JavaScript's own TypeError, or did nothing and answered null.
    const takes = ENGINE_PARAMS[method] ?? READ_PARAMS[method];
    const wrong = (why: string, rawError?: string) => new CliError("bad_request", `${method} takes ${takes || "no parameters"}: ${why} (ghostly engine --list --verbose)`, { takes, ...(rawError ? { rawError } : {}) });
    const problem = engineParamsProblem(method, args);
    if (problem) throw wrong(problem);
    // Removing the chat or putting it on DHT only is refused mid-call, as `chat remove` and `chat transport dht` are.
    if (typeof args?.linkId === "string") {
      if (method === "removeLink") {
        noCallOn(ctx, args.linkId, "remove the chat");
        if (!bool(params, "force")) noRemovalOnItsWay(ctx, [args.linkId]);
      }
      else if ((method === "setChatTransport" && args.transport === "dht") || (method === "setDeliveryMode" && args.mode === "dht")) noCallOn(ctx, args.linkId, "put the chat on DHT only");
    }
    if (args && ENGINE_SENDS.has(method) && !bool(params, "force")) await guardEngineSend(ctx, method, args);
    if (method === "getMessages") return node(ctx).getMessages(str(args ?? {}, "linkId", true));
    if (method === "getState") return state(ctx);
    // Someone chose the chat on screen: an invite's mark no longer clears it.
    if (method === "setActiveLink") inviteShown.get(ctx)?.();
    const target = (node(ctx) as unknown as Record<string, (p?: unknown) => unknown>)[method];
    if (typeof target !== "function") throw new CliError("not_found", `The engine has no call ${method}`);
    const removedPeer = method === "removeLink" ? state(ctx).links.find((link) => link.id === args?.linkId)?.peerPubKeyZ32 : undefined;
    try {
      const result = (await target.call(node(ctx), args)) ?? null;
      // The chat is gone, as with `chat remove`: auto-answer and auto-join no longer name it, its hold goes with it and its
      // services opened here close.
      if (method === "removeLink") {
        ctx.calls.forgetChat(str(args ?? {}, "linkId", true));
        ctx.groupAuto.forgetChat(str(args ?? {}, "linkId", true));
        await forgetHold(ctx, str(args ?? {}, "linkId", true));
        if (removedPeer) await closeServicesOf(ctx, removedPeer);
      }
      // A transport chosen during a hold ends it, as `chat transport` does: its time running out takes nothing back.
      if ((method === "setChatTransport" || method === "setDeliveryMode") && typeof args?.linkId === "string") await releaseHold(ctx, args.linkId, "lifted", true);
      return result;
    } catch (error) {
      // A value of the wrong kind (a number for a text, a missing key of a typed object) ends as JavaScript reading what is
      // not there. Not every TypeError: Node's `fetch failed` is the network.
      if (error instanceof TypeError && BAD_VALUE.test(error.message)) throw wrong("a parameter of the wrong kind", error.message);
      throw error;
    }
  },
};

/**
 * "Clear all data": the engine withdraws what it can, stops and empties its stores; the app reloads its page after it.
 * A daemon would go on serving the stopped engine's memory (chats and groups that are gone, new ones that are not
 * kept): it stops once it has answered, and the next command starts on the emptied profile.
 */
async function clearProfile(ctx: ApiContext, force: boolean): Promise<{ cleared: { chats: number; groups: number }; stopped?: true }> {
  // Every chat goes at once: mid-call, the call's hang-up had no chat left to cross, as with `chat remove` (`noCallOn`).
  const call = ctx.calls.list()[0];
  if (call) throw new CliError("busy", `A call is on in a chat: hang it up first (ghostly call hangup ${call.chat}), then clear the profile`, { call: call.call });
  const { links, groups } = state(ctx);
  if (!force) noRemovalOnItsWay(ctx, links.map((link) => link.id), true);
  await node(ctx).clearProfileData();
  const cleared = { chats: links.length, groups: groups.length };
  if (ctx.mode !== "daemon" || !ctx.stop) return { cleared };
  setTimeout(() => ctx.stop!(), 10);
  return { cleared, stopped: true };
}

/**
 * The engine's calls that send a text this side writes (a message, a file's caption, a payment's memo, a name others
 * read): `engine.call`
 * runs the secret guard of `send`, `edit` and `forward` on them too (docs/CLI.md § Safety), so a raw call is no way around it. `force: true` (`--force`) sends it.
 */
const ENGINE_SENDS: ReadonlySet<string> = new Set([
  "sendMessage", "sendGroupMessage", "editMessage", "forwardMessages", "sendGroupFile",
  // A payment's memo reaches the contact as a message's text does (`chat pay` and `chat request` guard it too).
  "sendPayment", "requestPayment", "requestGroupPayment", "askToPay",
  // The payment sheet's own path (its memo goes out with the token), an invoice's description the payer reads, and a
  // Lightning address's comment its owner reads (agents#1624).
  "preparePayment", "fedimintInvoice", "lnurlInvoice",
  // A group's name, the name contacts see and a file's name, as `group create`, `group rename`, `profile set` and
  // `file send` guard them.
  "createGroup", "renameGroup", "updateSettings", "sendFile",
  // The status every contact reads, as `status set` guards it.
  "setOwnStatus",
  // A Nostr note or profile, public on relays: the app asks before it is signed (NostrPublishDialog).
  "nostrDraft",
]);

/**
 * The most a message's text carries, in a chat or a group, sent or edited: UTF-8 bytes of the trimmed text, as the
 * engine counts them. The engine refuses a longer one before it keeps or sends anything.
 */
const ENGINE_TEXT_BYTES = Math.max(LIMITS.maxChatMessageBytes, GROUP_LIMITS.textBytes, COMMUNITY_LIMITS.textBytes, GROUP_EDIT_TEXT_BYTES);

/**
 * Per call, the fields the engine refuses the whole call for past their bound, before it keeps or sends anything:
 * a message's or an edit's text and a group file's caption past `ENGINE_TEXT_BYTES`, a status card past
 * `STATUS_CARD_LIMITS.bytes`. Only these: other fields (a memo, a name, a status) may go at other sizes.
 */
const REFUSED_PAST_BOUND: Readonly<Record<string, readonly ("text" | "caption" | "card")[]>> = {
  sendMessage: ["text", "card"], editMessage: ["text", "card"], sendGroupMessage: ["text", "card"], sendGroupFile: ["caption"],
};

/** Whether the engine refuses `value` as this field of the call, by its size alone (`REFUSED_PAST_BOUND`). */
function pastEngineBound(method: string, field: "text" | "caption" | "card", value: unknown): boolean {
  if (!REFUSED_PAST_BOUND[method]?.includes(field)) return false;
  if (field === "card") return value !== undefined && statusCardBytes(value) > STATUS_CARD_LIMITS.bytes;
  return typeof value === "string" && new TextEncoder().encode(value.trim()).length > ENGINE_TEXT_BYTES;
}

/**
 * The secret guard of a raw engine send. A text the engine refuses by its size alone is not read for a secret (a
 * 15 MB one held the daemon's thread for seconds): the engine answers it with its size, as it did once the guard was
 * done, and nothing of it is kept or sent.
 */
async function guardEngineSend(ctx: ApiContext, method: string, args: Params): Promise<void> {
  const of = (value: unknown, key: string) => (value && typeof value === "object" ? (value as Params)[key] : undefined);
  const read = (field: "text" | "caption" | "card") => (pastEngineBound(method, field, args[field]) ? undefined : args[field]);
  let texts: unknown = [read("text"), read("card"), read("caption"), args.memo, args.comment, args.name, of(args.settings, "nick"), of(args.file, "name"), of(args.status, "text"), args.content,
    ...(args.fields && typeof args.fields === "object" ? Object.values(args.fields) : [])];
  if (method === "forwardMessages") {
    // Each id once, and none past the engine's bound, which it refuses before reading any: as `chat.forward` reads them.
    // One id given 50,000 times was read as often, all at once, for the engine's refusal or its one message.
    const ids = Array.isArray(args.messageIds) ? [...new Set(args.messageIds.filter((id): id is string => typeof id === "string"))] : [];
    const linkId = args.linkId;
    texts = typeof linkId === "string" && linkId && ids.length <= FORWARD_MESSAGES ? await Promise.all(ids.map(async (id) => {
      const message = await node(ctx).getMessage(linkId, id);
      return message && !message.file ? message.text : null;
    })) : [];
  }
  const secret = secretIn(texts);
  if (secret) throw new CliError("confirm", `The text looks like ${secretWords(secret)}; call ${method} with --force if you mean to`, { kind: secret.kind });
}

/**
 * How long `edit`, `react` and `pin` in a 1:1 chat wait for the contact: a one-shot until it confirmed, since what is
 * not said yet leaves with the process; a daemon goes on saying it, so it answers at once unless asked to wait, as a
 * one-shot does on a chat nobody joined yet (`oneShotWaits`).
 */
function confirmWait(ctx: ApiContext, params: Params, chat: string): { wait: "none" | "confirmed"; ms: number } {
  const wait = oneOf(params, "wait", ["none", "confirmed"] as const, oneShotWaits(ctx, chat) ? "confirmed" : "none");
  return { wait, ms: num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000 };
}

/**
 * Reacts to a message of a chat or a group (`group:<id>`): `emoji`, or `remove` for "" (WISP 400 § Reactions). In a
 * group, `n` is the reaction's number, for `groupTaken`.
 */
async function react(ctx: ApiContext, linkId: string, params: Params, place: RefPlace): Promise<{ messageId: string; emoji: string | null; removed: boolean; n?: number }> {
  const messageId = str(params, "message", true);
  const removed = bool(params, "remove");
  const emoji = removed ? "" : str(params, "emoji");
  if (!removed && !emoji) throw new CliError("usage", "Give one emoji, or --remove to take yours back");
  const result = await node(ctx).react({ linkId, messageId, emoji: emoji ?? "" });
  const gone = result.error ? notHere(result.error, messageId, place) : undefined;
  if (gone) throw gone;
  if (result.error) throw new CliError(result.refused ? "refused" : /not in this (?:chat|group)|No reaction of yours/.test(result.error) ? "not_found" : "bad_request", result.error);
  return { messageId, emoji: emoji || null, removed, ...(result.n ? { n: result.n } : {}) };
}

/**
 * What `typing` says: a kind, and a status a bot writes. The contact's app would cut a long status and drop one with
 * a link; here that is an error instead, so the bot learns what the contact will (not) see. A blank status is none.
 * The command checks both first (commands/shared.ts `typingWords`): these words are the socket's.
 */
function typingWord(params: Params, typing: boolean): { kind: TypingKind; status?: string } {
  const kind = oneOf(params, "kind", TYPING_KINDS, "typing");
  const raw = str(params, "status");
  if (!typing && (params.kind !== undefined || raw?.trim())) throw new CliError("bad_request", "kind and status go with a start, not with stop");
  const status = typingStatus(raw, "status", "bad_request");
  return status ? { kind, status } : { kind };
}

/**
 * A group message the engine did not send, by what a bot can do about it: a `--reply` to a message this group does not
 * have is `not_found` (exit 3), as `group react`, `group edit` and `pin` answer for one; out of the group (removed,
 * left, a forked history) is `refused`: it will not go later either. Anything else may go on a later try
 * (`unavailable`): the epoch's key is still on its way. All three were `unavailable` (exit 1) before.
 */
export function groupSendRefused(error: string): CliError {
  if (/not in this chat|cannot be replied to/.test(error)) return new CliError("not_found", error);
  if (/^You (were removed from|left|are no longer in) this group$|Membership changes are halted/.test(error)) return new CliError("refused", error);
  return new CliError("unavailable", error);
}

/** The engine's admin who may not leave: the app's words say "make someone the admin", which names no command here. */
const ADMIN_ALONE = "You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first.";

/**
 * `group leave` the engine refused, said with the CLI's next step: an invitation not joined yet answered "Group not
 * found" of a group `group show` lists (its way out is `group decline`), and an admin alone online "make someone the
 * admin", the app's words. The code stays the engine's.
 */
function leaveRefused(group: GroupView, ref: string, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const shown = shellWord(ref, group.id);
  if (error.message === ADMIN_ALONE) return new CliError("engine", `You are the admin and nobody else in ${groupCalled(group)} is online to take over: try again when a member is, or make one the admin first (ghostly group admin ${shown} <member key>)`);
  const yet = error.message === "Group not found" ? notInYet(group, ref, true) : undefined;
  return yet ? new CliError("engine", yet) : error;
}

/**
 * `group join` the engine refused for a group held here under the link's id, in the app's words ("Delete it from this
 * device", its menu item), said with the CLI's command. The code stays the engine's. "Answer it first" comes only for
 * an invitation taken back (a live one is kept and the link goes on beside it), which `group accept` refuses: its way
 * out is `group decline`.
 */
/**
 * The link `group join` takes, read before a one-shot opens the profile (`refuseBeforeStart`): one that names no group,
 * a private one's or a community's, is refused as the engine's `joinByLink` refuses it with the same two decoders.
 */
function groupLinkShape(params: Params): void {
  const link = str(params, "link", true);
  if (!decodeCommunityLink(link) && !decodeGroupEntryLink(link)) throw new CliError("bad_request", "This is not a link to a group");
}

function joinRefused(link: string, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const id = (decodeCommunityLink(link) ?? decodeGroupEntryLink(link))?.g ?? "<group>";
  if (error.message === "You are out of this group and its history is still here. Delete it from this device to join with a link.") {
    return new CliError("engine", `You are out of this group and its history is still here: ghostly group forget ${id} --yes deletes it from this device, then join with the link`);
  }
  if (error.message === "You have an invitation to this group. Answer it first.") {
    return new CliError("engine", `Its invitation to this group was taken back: ghostly group decline ${id} drops it, then join with the link`);
  }
  return error;
}

/**
 * The chat a command about a chat's own connection names (`chat connect`, `disconnect`, `transport`, `wait`): a group's
 * name says a group has none of its own, as `chat show` names `group show`. It read "(ghostly chat list)", a list that
 * never has the group.
 */
function chatNotGroupLink(ctx: ApiContext, params: Params) {
  return notAGroup(ctx, params, () => chatOf(ctx, params), (shown, id) => `it connects through its members' chats, with no transport of its own (${id === undefined ? "ghostly group list" : `ghostly group show ${shown}`})`);
}

/**
 * A chat command given a group's id, prefix or name: `not_found` that says it is a group, with `hint`: the group
 * command that takes it (`react` on a group, where `group react` is meant), or what to do where none does. `group:<id>`,
 * the form `pin` and `saved` take, is that group too (it read "No chat" before). A name no chat and no group has stays
 * the chat's error. A name more than one group has says so too, with no `id` for `hint` (`shown` is `<group>`): the
 * group to name is one of theirs, by its id (`ghostly group list`). That one is `bad_request` (exit 1), as every group
 * command and `noChat` refuse it: it was `not_found` here and `bad_request` there for the same name.
 */
function notAGroup<T>(ctx: ApiContext, params: Params, chat: () => T, hint: (shown: string, id?: string) => string): T {
  try { return chat(); } catch (error) {
    if (!(error instanceof CliError) || (error.code !== "not_found" && !groupsNotChat(error))) throw error;
    const ref = str(params, "chat", true);
    const named = groupPrefixed(ref) ?? ref;
    let group: GroupView;
    try { group = findGroup(state(ctx).groups, named); } catch (inner) {
      // A name two groups share is still a group's (it read `No chat`): the hint, with no one group's id to name.
      if (sharedGroupIds(inner)) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one group, not a chat: ${hint("<group>")}`);
      throw error;
    }
    const shown = shellWord(named, group.id);
    throw new CliError("not_found", `${JSON.stringify(ref)} is a group, not a chat: ${hint(shown, group.id)}`, { group: group.id });
  }
}

/** Where a command offered for a name more than one group has (no `id`) finds the id of the one meant. */
const byItsId = (id: string | undefined) => (id === undefined ? ", with the id of the group meant (ghostly group list)" : "");

/** The chat a chat command with a group twin names: a group's name says so, with `command`, the twin (see `notAGroup`). */
function chatNotGroup(ctx: ApiContext, params: Params, command: string, rest = "") {
  return notAGroup(ctx, params, () => chatOf(ctx, params), (shown, id) => `ghostly ${command} ${shown}${rest ? ` ${rest}` : ""}${byItsId(id)}`);
}

/**
 * An edit the engine refused. A message that is not in the chat or group at all is `not_found` (exit 3), said as every
 * message id is (`noMessage`); before, a mistyped or lost id read "Only your own text messages can be edited"
 * (`refused`, exit 1), as if the message were someone else's. Whether it is there is the engine's answer (`missing`)
 * once it looked for it: read again here, an id no message goes by read the chat's whole history a second time (0.7 s
 * at 100,000 messages). Only a refusal before it looked (a chat that cannot edit, a group I am not in) looks here.
 */
async function editRefused(ctx: ApiContext, linkId: string, ref: string, place: RefPlace, error: string, result: { refused?: boolean; missing?: boolean }): Promise<CliError> {
  if (!result.refused) return new CliError("unavailable", error);
  if (result.missing ?? !(await messageOf(ctx, linkId, ref))) return noMessage(ref, place);
  return new CliError("refused", editRefusalWords(error, ref, place));
}

/**
 * The engine's refusal of an edit with what to run instead: it named none, so a bot that hit the edit cap had a sentence
 * and exit 1 to go on. Matched by the engine's exact words (`editMessage`, `GroupEdits.edit`); any other sentence, or
 * one these no longer match, stays the engine's.
 */
function editRefusalWords(error: string, ref: string, place: RefPlace): string {
  const chat = shellWord(place.ref, place.group ? "<group>" : "<chat>"), id = shellWord(ref, "<message>");
  const send = `ghostly ${place.group ? "group send" : "send"} ${chat}`;
  // A contact's message (or another member's), or one of mine that is no text: neither is edited, a reply answers it.
  if (error === "Only your own text messages can be edited") return `${error}: to answer this one, reply to it (${send} --reply ${id} <text>)`;
  const most = /^(This message was edited \d+ times, the most one takes)\.$/.exec(error);
  if (most) return `${most[1]}: send the new text as a new message (${send} <text>); ghostly message delete ${chat} ${id} --everyone takes the old one away`;
  // The text alone decides it (`isJoinNotice`: "👋 <name> joined", whole): other first words make it a text.
  if (error === "An edit cannot read as a join notice.") return "An edit cannot read as a join notice (\"👋 … joined\"): change its first words";
  return error;
}

/**
 * `message delete --everyone` given no message of mine. It said "No message … of yours" for all of them, as if one of
 * mine deleted already were the contact's: another's message says whose it is (in a chat, with the delete that takes
 * it off this device), one of mine deleted already says so (the chat's deleted ids), and any other is not here.
 */
function deleteNotMine(ctx: ApiContext, target: { linkId: string; group: boolean }, ref: string, theirs: StoredMessage | undefined, place: RefPlace, purge: boolean): CliError {
  if (theirs && target.group) return new CliError("not_found", `${JSON.stringify(ref)} is another member's message: only its author deletes a group's message, for everyone`);
  if (theirs) return new CliError("not_found", `${JSON.stringify(ref)} is the contact's message: only your own messages are deleted for everyone (ghostly message delete ${shellWord(place.ref, "<chat>")} ${shellWord(theirs.id, "<message>")}${purge ? " --purge" : ""} deletes it on this device)`);
  const deleted = !target.group && node(ctx).deletedIdsOf(target.linkId).includes(ref);
  return noMessage(ref, place, deleted ? { tail: ": it was deleted already" } : {});
}

/**
 * About the longest ASCII text, and edit, the DHT packet carries once sealed and signed: within the 256 bytes, the
 * envelope's authentication (and an edit's element) takes the rest. The edge moves by a byte or two with the chat (the
 * envelope's sequence, the edit's number), so the words say "about"; `dhtBudgetWords.test.ts` sends both sizes on two
 * paired daemons.
 */
const DHT_TEXT_FITS = 248, DHT_EDIT_FITS = 214;

/**
 * The engine's refusal of a text or an edit within 256 bytes that the DHT packet cannot carry (`DHT_PACKET_BUDGET`,
 * "Text and authentication exceed the DHT packet budget"), said as the apps and `dhtOnlyWait` say it: too long for the
 * DHT, about how much fits, and what ends it, by whose choice keeps the chat on the DHT only (this side's hold: when
 * it ends, and the command that ends it now). Any other error as is.
 */
function dhtTooLong(ctx: ApiContext, asked: LinkView, error: string, kind: "text" | "edit", ref: string): string {
  if (error !== DHT_PACKET_BUDGET) return error;
  // Read again: the contact's choice may have come with the envelope the engine read since the chat was looked up.
  const link = state(ctx).links.find((l) => l.id === asked.id) ?? asked;
  const mine = link.deliveryMode === "dht", theirs = link.dhtDelivery?.peerMode === "dht";
  const held = mine ? holdEnds(ctx, link.id) : null, chosen = mine && held === null;
  const fits = kind === "text" ? `a text fits about ${DHT_TEXT_FITS} bytes there` : `an edit fits about ${DHT_EDIT_FITS} bytes there`;
  const act = kind === "text" ? "send it" : "make the edit";
  const switchBack = `ghostly chat transport ${shellWord(ref, "<chat>")} auto`;
  const who = chosen && theirs ? `you and the contact keep this chat on the DHT only: ${act} once both choose a live transport (${switchBack}), or shorten it`
    : chosen ? `this chat is on the DHT only: ${act} once you choose a live transport (${switchBack}), or shorten it`
    : theirs ? `the contact keeps this chat on the DHT only: ${act} once they choose a live transport, or shorten it`
    : held !== null ? `${heldWords(held, ref, act)}, or shorten it`
    : `shorten it, or ${act} once the chat is live`;
  return `Too long for the DHT (${fits} once sealed): ${who}`;
}

/**
 * The engine's "That message is not in this chat" (", or takes no reaction", ", or cannot be pinned", ", or cannot be
 * replied to") for the message `id`, said as `noMessage` says it, with that reason kept; undefined for any other error.
 * The engine says "chat" in a group for a reply and a save: `place` says which it is.
 */
function notHere(error: string, id: string, place: RefPlace): CliError | undefined {
  const said = /^That message is not in this (?:chat|group)(?:, or (.+))?$/.exec(error);
  return said ? noMessage(id, place, said[1] ? { tail: `, or it ${said[1]}` } : {}) : undefined;
}

/** The chat link's own wait for a contact (`GhostLink.connect`): `chat connect --timeout` waits at most that long. */
const CONNECT_MAX_SECONDS = 90;

/**
 * `chat connect`, waiting at most `ms` for the contact; the link's dial goes on behind a shorter wait. Timed out (here,
 * or by the link's own 90 s), it says what happens next: before, it waited a fixed 90 s and ended "Timed out connecting
 * to the peer", with no next step.
 */
async function connectWithin(ctx: ApiContext, link: LinkView, ms: number): Promise<void> {
  const dial = node(ctx).connect({ linkId: link.id });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), ms); });
  try {
    if ((await Promise.race([dial, late])) !== "late") return;
  } catch (error) {
    // A DHT only learned while it dialled (the contact's, read from the DHT up to 30 s later) is said as before the dial.
    if (asCliError(error).code !== "timeout") {
      dhtOnly(findChat(state(ctx).links, link.id));
      const away = contactAway(error);
      if (away) throw new CliError("unavailable", `${away}. ${connectNext(ctx, link)}`, { chat: link.id, reason: (error as Error).message });
      throw error;
    }
  } finally { clearTimeout(timer); }
  throw new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s: ${notLiveYet(ctx, link)}. ${connectNext(ctx, link)}`, { chat: link.id });
}

/**
 * How long after a daemon's start a chat with no attempt ended yet reads as still resuming: with many chats, the start
 * brings them back a few at a time, over minutes.
 */
const RESUMING_MS = 5 * 60_000;

/**
 * Why a daemon's `chat connect` timed out, as the chat reads at the end. No attempt of this run ended yet
 * (`lastAttempt` null) while the daemon just started, or while the contact reads online: the chat is still coming
 * back, nobody failed to answer. It said "the contact did not answer" right after a `daemon restart`, with the
 * contact online. A one-shot always just started: it keeps the words it had.
 */
function notLiveYet(ctx: ApiContext, link: LinkView): string {
  const now = state(ctx).links.find((l) => l.id === link.id) ?? link;
  if (ctx.mode !== "daemon" || now.liveAttempt) return "the contact did not answer";
  if (process.uptime() * 1000 < RESUMING_MS) return "the chat is still resuming after the daemon's start, and no attempt to reach the contact has ended yet";
  return now.peerOnline ? "your contact's app reads online, and no attempt to reach it has ended yet" : "the contact did not answer";
}

/** What happens after a `chat connect` the contact did not answer: the daemon dials again by itself, a one-shot does not. */
function connectNext(ctx: ApiContext, link: LinkView): string {
  const shown = /^[\w.:-]+$/.test(link.label ?? "") ? link.label! : link.id;
  return ctx.mode === "one-shot"
    ? "Try again later, or keep this profile online with `ghostly daemon --detach`: it reconnects by itself"
    : `It reconnects by itself while this profile is online; ghostly chat wait ${shown} --until live waits for it`;
}

/**
 * A dial that ended because the contact's app is not there: the link's own "Could not connect to the peer", or
 * HyperDHT's errors as the app's errorText says them (closed, or asleep or frozen). They answered as they came, without
 * the next step; HyperDHT's as `engine`, "PEER_NOT_FOUND: Peer not found", as if this side had failed.
 */
function contactAway(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  const reason = /^Could not connect to the peer(?:: ([\s\S]*))?$/.exec(message);
  const native = reason ? reason[1] ?? "" : message;
  if (/^PEER_NOT_FOUND: /.test(native)) return "Your contact's app isn't reachable on HyperDHT: it may be closed";
  if (/^(?:PEER_CONNECTION_FAILED|BAD_HOLEPUNCH_REPLY|HOLEPUNCH_[A-Z_]+): /.test(native)) return "Your contact's app isn't answering on HyperDHT: it may be asleep or frozen";
  return reason ? "The contact did not answer" : undefined;
}

async function saveMark(ctx: ApiContext, params: Params, remove: boolean) {
  const target = chatOrGroup(ctx, str(params, "chat", true)), messageId = str(params, "message", true);
  const result = await node(ctx).saveMessage({ linkId: target.linkId, messageId, remove });
  // An id that names no message of the chat or group (a typo): said as pin and message details say it, in a group too
  // (the engine's line says "chat"); an unsave's with where the saved ids are.
  const where = target.group ? "group" : "chat";
  if (result.error && /not in this chat/.test(result.error)) {
    throw remove ? new CliError("not_found", `No saved message ${JSON.stringify(messageId)} in this ${where} (ghostly saved list shows the saved ones)`)
      : noMessage(messageId, { group: target.group, ref: str(params, "chat", true) });
  }
  if (result.error) throw new CliError("bad_request", result.error);
  return { [target.group ? "group" : "chat"]: target.id, messageId, saved: !remove };
}

/**
 * A page of a chat's or a group's history: only that page is read from the store (the newest, those before `before`,
 * or the oldest after `after`), so a long chat's is as quick as a short one's. `linesOf`: how the page's messages are
 * printed, once the page is read.
 */
type LinesOf = (page: readonly StoredMessage[]) => Promise<(message: StoredMessage) => MessageJson>;
async function historyOf(ctx: ApiContext, chat: string, params: Params, linesOf: LinesOf = async () => messageJson) {
  const limit = num(params, "limit", 50, { min: 1, max: 10_000, whole: true });
  const bound = (side: "before" | "after"): string | number | undefined => {
    const value = params[side] ?? undefined;
    if (value !== undefined && typeof value !== "number" && typeof value !== "string") throw new CliError("bad_request", `${side} must be a timestamp or a message id`);
    return value;
  };
  const before = bound("before"), after = bound("after");
  const page = await node(ctx).messagePage({ linkId: chat, limit, before, ...(after !== undefined && { after }) }).catch((error: unknown) => {
    const missing = [before, after].find((id) => error instanceof Error && error.message === `No message ${id}`);
    if (missing === undefined) throw error;
    const group = chat.startsWith("group:");
    throw noMessage(String(missing), { group, ref: str(params, group ? "group" : "chat", true) });
  });
  const originals = await originalsNow(ctx, chat, page.messages);
  const json = await linesOf(page.messages);
  return { messages: page.messages.map((m) => quoteChecked(json(m), m, originals)), more: page.more };
}

/**
 * The payment lines of a group's history page that are twins of a payment note's line (`groupPayTwins`), as the app
 * tells them. A note whose line is not on the page is read as its one row, as the originals of replies are.
 */
async function groupPayTwinsOf(ctx: ApiContext, group: GroupView, page: readonly StoredMessage[]): Promise<ReadonlyMap<string, string>> {
  const rows = page.filter((m) => m.paymentId && !m.groupPay);
  if (!rows.length) return new Map();
  const payments = state(ctx).payments ?? {};
  const notes = new Map(page.flatMap((m) => (m.groupPay ? [[m.groupPay.id, m.groupPay] as const] : [])));
  for (const id of new Set(rows.map((m) => groupPayNoteId(m.paymentId!, payments[m.paymentId!])))) {
    if (notes.has(id)) continue;
    const note = (await node(ctx).getMessage(`group:${group.id}`, groupPayLineId(id)))?.groupPay;
    if (note) notes.set(note.id, note);
  }
  return groupPayTwins(rows, notes, payments, group);
}

/** Past this many originals outside a page, its history is read once instead of row by row. */
const ORIGINAL_READS = 32;

/** Each original a page's replies name, by its id: its row as it is now, or undefined when it is gone. */
type Originals = ReadonlyMap<string, StoredMessage | undefined>;

/**
 * The originals a page's replies found here when they came, as they are now: gone (deleted on this device, or for
 * everyone by their author: WISP 400 § Delete for everyone), or the row, edited since or not. Each is looked for in the
 * page, else read as its one row, one at a time (a burst of reads stalls fake-indexeddb's scheduler); `whole` is the
 * chat's whole history when it was read already. Before, such a reply still said `found`, with the original's text.
 */
async function originalsNow(ctx: ApiContext, chat: string, page: readonly StoredMessage[], whole: readonly StoredMessage[] = page): Promise<Originals> {
  const here = new Map(whole.map((m) => [m.id, m]));
  const named = [...new Set(page.flatMap((m) => (m.replyTo?.messageId ? [m.replyTo.messageId] : [])))];
  const asked = named.filter((id) => !here.has(id));
  // Many (a long page of answers to old messages): the history once is cheaper than a burst of row reads.
  if (whole === page && asked.length > ORIGINAL_READS) return originalsNow(ctx, chat, page, await node(ctx).getMessages(chat));
  const originals = new Map<string, StoredMessage | undefined>(named.flatMap((id) => (here.has(id) ? [[id, here.get(id)]] : [])));
  // The whole history read: what is not in it is gone.
  for (const id of asked) originals.set(id, whole === page ? await node(ctx).getMessage(chat, id) : undefined);
  return originals;
}

/**
 * A reply's quote as the apps show it (`quoteFor`): an original gone reads "Original message deleted", not found and
 * none of its text; one edited since the reply quotes its text as it reads now. A button press keeps the question as
 * it was answered (WISP 406 · Message Buttons), and a card's or a file's line stays the one the reply carries.
 */
function quoteChecked(json: MessageJson, message: StoredMessage, originals: Originals): MessageJson {
  const id = message.replyTo?.messageId;
  if (!json.replyTo || !id || !originals.has(id)) return json;
  const original = originals.get(id);
  if (!original) return { ...json, replyTo: { ...json.replyTo, snippet: "", found: false, deleted: true } };
  if (!original.edit || json.replyTo.button || original.card || original.file) return json;
  return { ...json, replyTo: { ...json.replyTo, snippet: replySnippet(original.text) } };
}

/**
 * Each method's check of its own words, the one its handler makes first: none needs the profile. A one-shot makes it
 * before the profile opens (main.ts `session`): a target that is no invoice, a token or mint URL that is none, or a word
 * that is no group link started every saved chat to be refused (with 10 chats, 20 relay requests and 0.4 s more).
 */
const SHAPES: Record<string, (params: Params) => unknown> = {
  "pay": payShape, "wallet.redeem": tokenShape, "wallet.mint.add": mintUrlShape, "group.join": groupLinkShape, "service.add": serviceShape,
};

/** Throws what `method` answers `params` whose shape it refuses, with no profile open; nothing for any other. */
export async function refuseBeforeStart(method: string, params: Params): Promise<void> {
  if (Object.hasOwn(SHAPES, method)) await SHAPES[method](params);
}

export { findChat, findGroup, startNamedChats } from "./apiKit";
export { identityProvider } from "./identities";
export type { ApiContext } from "./apiKit";
export const API_METHODS: readonly string[] = Object.keys(METHODS);

/**
 * Runs one method of the API: one the table lists itself (`constructor`, which every object has, is none). `call`: who
 * asked, from a daemon's connection (`host.ts`).
 */
export async function callApi(ctx: ApiContext, method: string, params: unknown = {}, call?: CallScope): Promise<unknown> {
  const run = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
  if (!run) throw new CliError("not_found", `No method ${method}`);
  if (params === null || typeof params !== "object" || Array.isArray(params)) throw new CliError("bad_request", "params must be an object");
  return run(ctx, await withStoredIds(ctx, params as Params), call);
}
