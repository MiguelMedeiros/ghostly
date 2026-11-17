import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_AVATAR_LENGTH, MAX_AVATAR_SIDE, MAX_GROUP_CALL_SFU, NO_PICTURE_METADATA, groupCallSfu, sanitizeAvatar, stripPictureMetadata } from "@ghostly/core";
import type { GroupView } from "@ghostly/browser/shared/types";
import { bool, contactKeyOf, groupById, groupNameOf, groupOf, node, notInYet, ownChatOf, settingsOf, str, type ApiContext, type Method, type Params } from "./apiKit";
import { CliError, localFileError } from "./errors";
import { shellWord } from "./shellWord";
import { guardText } from "./secretGuard";
import { groupJson } from "./views";
import { outOf } from "./waits";

/**
 * Group administration and pictures (WISP 1100, phase 3): what the app's group menu and profile screen do. The
 * engine enforces who may do what (the admin); these check the arguments and name members.
 */

/**
 * A member by key, unique key prefix or name; never this profile itself (`myName`: its name, which its own row lacks).
 * A whole key is that member, whatever another member calls itself; a prefix and a name stand side by side (two
 * members is an error, not a guess). For a grant (`byKeyOnly`: admin, a pinned hub) a member found only by the name it
 * gave itself is refused, with its key: another member could call itself that name while the one meant is away, as
 * `findOwnNamedChat` refuses a contact's own name. `groupRef`: the group as the command named it, for the hint.
 */
export function findMember(group: GroupView, ref: string, myName?: string, byKeyOnly = false, groupRef?: string) {
  const lower = ref.toLowerCase();
  // A ref shaped as a key (a line break, a space or capitals left on it too) is only ever that key, never a name.
  const asKey = contactKeyOf(ref);
  if (asKey !== undefined) {
    const member = group.members.find((m) => !m.me && m.key === asKey);
    if (member) return member;
    throw noMember(group, asKey, myName, groupRef);
  }
  const others = group.members.filter((m) => !m.me);
  const byKey = others.filter((m) => m.key === ref);
  const matches = byKey.length ? byKey : others.filter((m) => m.key.startsWith(ref) || m.nick?.trim().toLowerCase() === lower);
  if (matches.length === 1) {
    if (byKeyOnly && !matches[0].key.startsWith(ref)) {
      throw new CliError("bad_request", `${JSON.stringify(ref)} names a member only by the name it gave itself: use its key`, { member: matches[0].key, name: matches[0].nick ?? null });
    }
    return matches[0];
  }
  throw matches.length ? moreThanOneMember(group, ref, matches, groupRef) : noMember(group, ref, myName, groupRef);
}

/** How many of the members a ref names the words list (all of them are in `details.matches`). */
const SHOWN_MATCHES = 5;

/**
 * Where a group's members and their keys are listed: `ghostly group show <group>`, with the group as the command named
 * it (`groupRef`, as `joined` says it), else by its id. Never by its name alone: the inviter picks it, so another group
 * may have it too, and `group show Tea` then answers that "Tea" names more than one group.
 */
const memberList = (group: GroupView, groupRef?: string) => `ghostly group show ${shellWord(groupRef ?? group.id, group.id)}`;

/**
 * A ref more than one member answers to (two members who call themselves "Bia", a prefix of two keys): refused as a
 * ref that names more than one chat or group is, with each one's key and name in `details.matches`. The words name
 * them too, by name and key prefix, and where their keys are listed: before, it was only "names more than one
 * member", and a person or a bot had to guess that a key is taken and go find it.
 */
export function moreThanOneMember(group: GroupView, ref: string, matches: readonly GroupView["members"][number][], groupRef?: string): CliError {
  const shown = matches.slice(0, SHOWN_MATCHES).map((m) => `${m.nick?.trim() || "no name"} (${m.key.slice(0, 8)}…)`).join(", ");
  const more = matches.length > SHOWN_MATCHES ? ` and ${matches.length - SHOWN_MATCHES} more` : "";
  return new CliError("bad_request", `${JSON.stringify(ref)} names more than one member of ${group.name}: ${shown}${more}. Use its key (${memberList(group, groupRef)})`, {
    matches: matches.map((m) => ({ key: m.key, name: m.nick?.trim() || null })),
  });
}

/**
 * A ref no other member answers to. When it is this profile's own key (or a prefix of it), or its own name, it says
 * so: "No member" read as if this profile were not in the group. Otherwise it says where the members are listed, as
 * `No group "x" (ghostly group list)` does.
 */
export function noMember(group: GroupView, ref: string, myName?: string, groupRef?: string): CliError {
  const mine = !!myName?.trim() && myName.trim().toLowerCase() === ref.toLowerCase();
  if (mine || group.members.some((m) => m.me && m.key.startsWith(ref))) return new CliError("bad_request", `${JSON.stringify(ref)} is you: name another member of ${group.name}`);
  return new CliError("not_found", `No member ${JSON.stringify(ref)} in ${group.name} (${memberList(group, groupRef)})`);
}

/**
 * A picture as Ghostly sends it: a square JPEG data URL, checked as a contact would check it. The app scales and
 * crops any image to 128×128; here the file must already be a JPEG within the bounds (no image library on Node).
 * It goes without its metadata (where it was taken, the device, the time), as the app's re-encoded one does; a
 * picture whose metadata cannot be removed is refused, never sent as it was.
 */
export async function pictureFrom(path: string): Promise<string> {
  let bytes: Buffer;
  // A folder or a file this user may not read is named as such, not "No file" for a path that is there.
  try { bytes = await readFile(resolve(path)); } catch (error) { throw localFileError(error, path) ?? new CliError("not_found", `No file ${path}`); }
  let parts: Uint8Array[] | undefined;
  try {
    // Told apart by its bytes, not a type: a file that is no picture at all stays the bad_request below.
    parts = stripPictureMetadata(bytes, "application/octet-stream");
  } catch (error) {
    if (error instanceof Error && error.message === NO_PICTURE_METADATA) throw new CliError("refused", NO_PICTURE_METADATA);
    throw error;
  }
  const url = `data:image/jpeg;base64,${(parts ? Buffer.concat(parts) : bytes).toString("base64")}`;
  const checked = sanitizeAvatar(url);
  const bounds = `a JPEG of at most ${MAX_AVATAR_SIDE}×${MAX_AVATAR_SIDE} px and about ${Math.floor(MAX_AVATAR_LENGTH * 0.74 / 1000)} KB (128×128 is what the app sends)`;
  // A PNG, even 1×1, is not too big: resizing it would not help.
  if (!checked && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw new CliError("bad_request", `${path} is not a JPEG: convert it to ${bounds}`);
  if (!checked) throw new CliError("bad_request", `A picture is ${bounds}: resize it first`);
  return checked;
}

async function picture(params: Params): Promise<string | null> {
  // Refused as the command line refuses `--clear` with a <jpeg>: before, `clear` won and the picture went, exit 0.
  if (bool(params, "clear") && str(params, "path") !== undefined) throw new CliError("bad_request", "clear removes the picture: not with path");
  if (bool(params, "clear")) return null;
  return pictureFrom(str(params, "path", true));
}

/**
 * The node a group's calls go through (WISP 602): an https origin in its one spelling, refused here before anything is
 * signed. A URL that names an https origin in another spelling (a path, a trailing `/`, capitals, `:443`) is told that
 * origin, and an origin past the limit is told the limit: before, both were told of a path, query or `/` it may not have.
 */
function callNode(raw: string, ref: string, groupId: string): string {
  const sfu = groupCallSfu(raw);
  if (sfu) return sfu;
  let origin: string | undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") origin = url.origin;
  } catch { /* no URL at all */ }
  const quoted = JSON.stringify(raw);
  if (!origin) throw new CliError("bad_request", `${quoted} is not an https origin: a call node is like https://call.example.com`);
  if (origin.length > MAX_GROUP_CALL_SFU) throw new CliError("bad_request", `${quoted} is too long: a call node is an https origin of at most ${MAX_GROUP_CALL_SFU} characters`);
  throw new CliError("bad_request", `${quoted} is not in its one spelling (lower case, no default port, path, query or trailing /): ghostly group call ${shellWord(ref, groupId)} --sfu ${origin}`);
}

/**
 * A group this profile administers or is in, not only an invitation: before, the engine answered `group rename`,
 * `picture`, `link`, `rotate` and `invite` on an invitation not yet joined with "Group not found" (engine, exit 1),
 * while `group show` listed it, and `remove`/`admin` said "No member" of a member list it had not received yet.
 */
function joined(ctx: ApiContext, params: Params, twin?: string): GroupView {
  const group = groupOf(ctx, params, twin);
  const yet = notInYet(group, str(params, "group", true));
  if (yet) throw new CliError("refused", yet);
  return group;
}

/** The member `params.member` names in `group`, this profile's own name said to be it; by its key only for a grant. */
const member = (ctx: ApiContext, group: GroupView, params: Params, grant = false) => findMember(group, str(params, "member", true), settingsOf(ctx).nick, grant, str(params, "group", true));

/** Where the app opens a group's link, as its Share gives it (WISP 903: `https://…/#/join/group2/…`). */
export const GROUP_LINK_ORIGIN = "https://app.ghostly.tools";

/**
 * A group's link and the address that opens it in the app, as `invite create` answers `invite` and `link`. Only the
 * token (`group2/…`) was given: pasted in a chat it is no link anyone can tap, and the app's own Share link is this one.
 */
export const withUrl = (group: string, link: string | null) => ({ group, link, ...(link && { url: `${GROUP_LINK_ORIGIN}/#/join/${link}` }) });

const view = (ctx: ApiContext, id: string, params: Params) => groupJson(groupOf(ctx, { group: id }), bool(params, "showSecret"));

export const GROUP_ADMIN_METHODS: Record<string, Method> = {
  async "group.invite"(ctx, params) {
    const group = joined(ctx, params);
    // The one invited reads the group from then on: a contact's own name or a prefix of its id never names it.
    const link = ownChatOf(ctx, params);
    await node(ctx).inviteToGroup({ groupId: group.id, linkId: link.id });
    return view(ctx, group.id, params);
  },
  async "group.remove"(ctx, params) {
    const group = joined(ctx, params);
    const removed = member(ctx, group, params);
    await node(ctx).removeGroupMember({ groupId: group.id, key: removed.key });
    // While the link is on, whoever holds it joins (WISP 902 § Entry link), the member just removed too: said as the
    // app's Remove dialog says it.
    const linkOn = !!(groupById(ctx, group.id) ?? group).entryLink;
    return { ...view(ctx, group.id, params),
      ...(linkOn && { warning: `${removed.nick ?? "They"} can still join again with the group's link: ghostly group link ${group.id} --reset gives it a new one and keeps them out` }) };
  },
  async "group.admin"(ctx, params) {
    const group = joined(ctx, params);
    await node(ctx).makeGroupAdmin({ groupId: group.id, key: member(ctx, group, params, true).key });
    return view(ctx, group.id, params);
  },
  async "group.hub"(ctx, params) {
    const group = joined(ctx, params);
    const role = str(params, "role") ?? "auto";
    if (!["pin", "exclude", "auto"].includes(role)) throw new CliError("bad_request", "role is pin, exclude or auto");
    await node(ctx).setGroupHub({ groupId: group.id, key: member(ctx, group, params, role === "pin").key, role: role === "auto" ? null : role as "pin" | "exclude" });
    return view(ctx, group.id, params);
  },
  async "group.rename"(ctx, params) {
    const group = joined(ctx, params, "chat rename <chat> <name...>");
    const name = groupNameOf(params);
    // Every member reads it, and a community's anyone who opens its link (docs/CLI.md § Safety).
    guardText(name, bool(params, "force"), "group's name", "rename it");
    await node(ctx).renameGroup({ groupId: group.id, name });
    return view(ctx, group.id, params);
  },
  async "group.rotate"(ctx, params) {
    const group = joined(ctx, params);
    await node(ctx).rotateGroup({ groupId: group.id });
    return view(ctx, group.id, params);
  },
  async "group.link"(ctx, params) {
    const group = joined(ctx, params);
    // A member removed (or gone) is refused as `group send` is: before, it got the link it held when it was removed,
    // exit 0, though `group show` said link null and the admin may have reset it or turned it off since.
    const out = outOf(group);
    if (out) throw new CliError("refused", out);
    // On unless `on` says otherwise; an `on` that is no boolean ("false", 0) is refused, never read as on.
    const on = params.on === undefined || bool(params, "on"), reset = bool(params, "reset");
    if (!on && reset) throw new CliError("bad_request", "on: false turns the link off: not with reset");
    if (!on) {
      await node(ctx).disableGroupLink({ groupId: group.id });
      return { group: group.id, link: null };
    }
    // A community member asking for a link the admin turned off: the engine's "Only the admin can replace or turn off
    // the group's link" answered what it had not asked. Said as the app says it (`group.link.offMember`).
    if (group.profile === "community" && !group.isAdmin && !group.entryLink && !reset)
      throw new CliError("refused", "The admin turned the link off: nobody can join with it, and the link shared before will not work again. Only the admin can make a new one.");
    const { link } = await node(ctx).enableGroupLink({ groupId: group.id, ...(reset ? { reset: true } : {}) });
    return withUrl(group.id, link);
  },
  async "group.picture"(ctx, params) {
    const group = joined(ctx, params);
    await node(ctx).setGroupPicture({ groupId: group.id, picture: await picture(params) });
    return { group: group.id, picture: !bool(params, "clear") };
  },
  async "group.call"(ctx, params) {
    const group = joined(ctx, params);
    if (group.profile !== "community") throw new CliError("refused", `${group.name} is a private group: only a community group has calls through a node`);
    // A profile out of the group (removed, or the admin who left) is told why, as the engine's rename and picture say
    // it: before, "Only the admin" to them all.
    const out = outOf(group);
    if (out) throw new CliError("refused", out);
    if (!group.isAdmin) throw new CliError("refused", `Only the admin of ${group.name} sets its call node`);
    const ref = str(params, "group", true), raw = str(params, "sfu");
    const e2ee = params.e2ee === undefined || params.e2ee === null ? undefined : bool(params, "e2ee");
    let sfu: string | null;
    // Refused as the command line refuses them with `--clear`: before, `clear` won and the node went, exit 0.
    if (bool(params, "clear") && raw !== undefined) throw new CliError("bad_request", "clear removes the call node: not with sfu");
    if (bool(params, "clear") && e2ee !== undefined) throw new CliError("bad_request", "clear removes the call node: not with e2ee");
    if (bool(params, "clear")) sfu = null;
    // An empty `--sfu` ("$NODE" unset) is refused with `--e2ee` too: before, it read as no --sfu and signed the old node again.
    else if ((params.sfu !== undefined && params.sfu !== null) || e2ee === undefined) sfu = callNode(str(params, "sfu", true), ref, group.id);
    // `--e2ee` alone turns sealed media on or off for the node the group names already.
    else if (group.call) sfu = group.call.sfu;
    else throw new CliError("refused", `${group.name} has no call node: ghostly group call ${shellWord(ref, group.id)} --sfu <https origin>${e2ee ? " --e2ee" : ""}`);
    await node(ctx).setGroupCall({ groupId: group.id, sfu, ...(sfu !== null && e2ee !== undefined && { e2ee }) });
    return view(ctx, group.id, params);
  },
  async "profile.picture"(ctx, params) {
    const avatar = await picture(params);
    await node(ctx).updateSettings({ settings: { avatar: avatar ?? "" } });
    return { picture: avatar !== null };
  },
};
