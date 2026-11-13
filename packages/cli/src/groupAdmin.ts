import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_AVATAR_LENGTH, MAX_AVATAR_SIDE, NO_PICTURE_METADATA, sanitizeAvatar, stripPictureMetadata } from "@ghostly/core";
import type { GroupView } from "@ghostly/browser/shared/types";
import { bool, contactKeyOf, groupNameOf, groupOf, node, ownChatOf, state, str, type ApiContext, type Method, type Params } from "./apiKit";
import { CliError, localFileError } from "./errors";
import { guardText } from "./secretGuard";
import { groupJson } from "./views";

/**
 * Group administration and pictures (WISP 1100, phase 3): what the app's group menu and profile screen do. The
 * engine enforces who may do what (the admin); these check the arguments and name members.
 */

/**
 * A member by key, unique key prefix or name; never this profile itself (`myName`: its name, which its own row lacks).
 * A whole key is that member, whatever another member calls itself; a prefix and a name stand side by side (two
 * members is an error, not a guess). For a grant (`byKeyOnly`: admin, a pinned hub) a member found only by the name it
 * gave itself is refused, with its key: another member could call itself that name while the one meant is away, as
 * `findOwnNamedChat` refuses a contact's own name.
 */
export function findMember(group: GroupView, ref: string, myName?: string, byKeyOnly = false) {
  const lower = ref.toLowerCase();
  // A ref shaped as a key (a line break, a space or capitals left on it too) is only ever that key, never a name.
  const asKey = contactKeyOf(ref);
  if (asKey !== undefined) {
    const member = group.members.find((m) => !m.me && m.key === asKey);
    if (member) return member;
    throw noMember(group, asKey, myName);
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
  throw matches.length ? new CliError("bad_request", `${JSON.stringify(ref)} names more than one member`) : noMember(group, ref, myName);
}

/**
 * A ref no other member answers to. When it is this profile's own key (or a prefix of it), or its own name, it says
 * so: "No member" read as if this profile were not in the group.
 */
export function noMember(group: GroupView, ref: string, myName?: string): CliError {
  const mine = !!myName?.trim() && myName.trim().toLowerCase() === ref.toLowerCase();
  if (mine || group.members.some((m) => m.me && m.key.startsWith(ref))) return new CliError("bad_request", `${JSON.stringify(ref)} is you: name another member of ${group.name}`);
  return new CliError("not_found", `No member ${JSON.stringify(ref)} in ${group.name}`);
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
  if (bool(params, "clear")) return null;
  return pictureFrom(str(params, "path", true));
}

/**
 * A group this profile administers or is in, not only an invitation: before, the engine answered `group rename`,
 * `picture`, `link`, `rotate` and `invite` on an invitation not yet joined with "Group not found" (engine, exit 1),
 * while `group show` listed it, and `remove`/`admin` said "No member" of a member list it had not received yet.
 */
function joined(ctx: ApiContext, params: Params, twin?: string): GroupView {
  const group = groupOf(ctx, params, twin);
  if (group.status || !group.invitation) return group;
  const ref = str(params, "group", true), shown = /^[\w.:-]+$/.test(ref) ? ref : JSON.stringify(ref);
  throw new CliError("refused", group.invitation.accepted
    ? `You are not in ${group.name} yet: you accepted its invitation, and its admin has not let you in`
    : `You are not in ${group.name} yet: ghostly group accept ${shown} joins it`);
}

/** The member `params.member` names in `group`, this profile's own name said to be it; by its key only for a grant. */
const member = (ctx: ApiContext, group: GroupView, params: Params, grant = false) => findMember(group, str(params, "member", true), state(ctx).settings.nick, grant);

const view = (ctx: ApiContext, id: string, params: Params) => groupJson(state(ctx).groups.find((g) => g.id === id) ?? groupOf(ctx, { group: id }), bool(params, "showSecret"));

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
    const linkOn = !!(state(ctx).groups.find((g) => g.id === group.id) ?? group).entryLink;
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
    if (params.on === false) {
      await node(ctx).disableGroupLink({ groupId: group.id });
      return { group: group.id, link: null };
    }
    const { link } = await node(ctx).enableGroupLink({ groupId: group.id, ...(bool(params, "reset") ? { reset: true } : {}) });
    return { group: group.id, link };
  },
  async "group.picture"(ctx, params) {
    const group = joined(ctx, params);
    await node(ctx).setGroupPicture({ groupId: group.id, picture: await picture(params) });
    return { group: group.id, picture: !bool(params, "clear") };
  },
  async "profile.picture"(ctx, params) {
    const avatar = await picture(params);
    await node(ctx).updateSettings({ settings: { avatar: avatar ?? "" } });
    return { picture: avatar !== null };
  },
};
