import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_AVATAR_LENGTH, MAX_AVATAR_SIDE, sanitizeAvatar } from "@ghostly/core";
import type { GroupView } from "@ghostly/browser/shared/types";
import { bool, chatOf, groupOf, node, state, str, type ApiContext, type Method, type Params } from "./apiKit";
import { CliError } from "./errors";
import { groupJson } from "./views";

/**
 * Group administration and pictures (WISP 11xx, phase 3): what the app's group menu and profile screen do. The
 * engine enforces who may do what (the admin); these check the arguments and name members.
 */

/** A member by key, unique key prefix or name; never this profile itself. */
export function findMember(group: GroupView, ref: string) {
  const lower = ref.toLowerCase();
  const matches = group.members.filter((m) => !m.me && (m.key === ref || m.key.startsWith(ref) || m.nick?.trim().toLowerCase() === lower));
  if (matches.length === 1) return matches[0];
  throw new CliError(matches.length ? "bad_request" : "not_found", matches.length ? `${JSON.stringify(ref)} names more than one member` : `No member ${JSON.stringify(ref)} in ${group.name}`);
}

/**
 * A picture as Ghostly sends it: a square JPEG data URL, checked as a contact would check it. The app scales and
 * crops any image to 128×128; here the file must already be a JPEG within the bounds (no image library on Node).
 */
export async function pictureFrom(path: string): Promise<string> {
  let bytes: Buffer;
  try { bytes = await readFile(resolve(path)); } catch { throw new CliError("not_found", `No file ${path}`); }
  const url = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  const checked = sanitizeAvatar(url);
  if (!checked) throw new CliError("bad_request", `A picture is a JPEG of at most ${MAX_AVATAR_SIDE}×${MAX_AVATAR_SIDE} px and about ${Math.floor(MAX_AVATAR_LENGTH * 0.74 / 1000)} KB (128×128 is what the app sends): resize it first`);
  return checked;
}

async function picture(params: Params): Promise<string | null> {
  if (bool(params, "clear")) return null;
  return pictureFrom(str(params, "path", true));
}

const view = (ctx: ApiContext, id: string, params: Params) => groupJson(state(ctx).groups.find((g) => g.id === id) ?? groupOf(ctx, { group: id }), bool(params, "showSecret"));

export const GROUP_ADMIN_METHODS: Record<string, Method> = {
  async "group.invite"(ctx, params) {
    const group = groupOf(ctx, params);
    const link = chatOf(ctx, params);
    await node(ctx).inviteToGroup({ groupId: group.id, linkId: link.id });
    return view(ctx, group.id, params);
  },
  async "group.remove"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).removeGroupMember({ groupId: group.id, key: findMember(group, str(params, "member", true)).key });
    return view(ctx, group.id, params);
  },
  async "group.admin"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).makeGroupAdmin({ groupId: group.id, key: findMember(group, str(params, "member", true)).key });
    return view(ctx, group.id, params);
  },
  async "group.rotate"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).rotateGroup({ groupId: group.id });
    return view(ctx, group.id, params);
  },
  async "group.link"(ctx, params) {
    const group = groupOf(ctx, params);
    if (params.on === false) {
      await node(ctx).disableGroupLink({ groupId: group.id });
      return { group: group.id, link: null };
    }
    const { link } = await node(ctx).enableGroupLink({ groupId: group.id, ...(bool(params, "reset") ? { reset: true } : {}) });
    return { group: group.id, link };
  },
  async "group.picture"(ctx, params) {
    const group = groupOf(ctx, params);
    await node(ctx).setGroupPicture({ groupId: group.id, picture: await picture(params) });
    return { group: group.id, picture: !bool(params, "clear") };
  },
  async "profile.picture"(ctx, params) {
    const avatar = await picture(params);
    await node(ctx).updateSettings({ settings: { avatar: avatar ?? "" } });
    return { picture: avatar !== null };
  },
};
