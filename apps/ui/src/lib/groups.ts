import { MAX_GROUP_NAME_BYTES, MAX_GROUP_NAME_LENGTH, decodeCommunityLink, decodeGroupEntryLink, groupEntryUrl, type PairedTransport } from "@ghostly/core";
import { getPrefix, setSessionDraft } from "./storage";
import { setChatFolder } from "./chatFolders";
import { forgetChatMute, groupChat } from "./chatMute";
import type { GroupEdgeView, GroupMemberView, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { publicKeyLabel } from "./publicKeyLabel";
import { transportName } from "./connection";
import { ago } from "./time";
import { english } from "./english";
import { relayCause } from "./problemText";
import type { Translate } from "../contexts/I18nContext";

type Segmenter = { segment(text: string): Iterable<{ segment: string }> };
const SegmenterCtor = (globalThis as { Intl?: { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter } }).Intl?.Segmenter;
const graphemes = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: "grapheme" }) : null;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * What a group's name field keeps of what was typed or pasted: as much as `groupName` takes, counted as it counts
 * (characters, `MAX_GROUP_NAME_LENGTH`, and bytes, `MAX_GROUP_NAME_BYTES`), cut between whole emoji. An input's
 * `maxLength` counts UTF-16 units: a name of emoji stopped at 32 of them, a family at 5 (agents#1048).
 */
export function fitGroupName(value: string): string {
  if ([...value].length <= MAX_GROUP_NAME_LENGTH && utf8Bytes(value) <= MAX_GROUP_NAME_BYTES) return value;
  const parts = graphemes ? Array.from(graphemes.segment(value), (s) => s.segment) : [...value];
  let kept = "", chars = 0, bytes = 0;
  for (const part of parts) {
    const c = [...part].length, b = utf8Bytes(part);
    if (chars + c > MAX_GROUP_NAME_LENGTH || bytes + b > MAX_GROUP_NAME_BYTES) break;
    kept += part; chars += c; bytes += b;
  }
  return kept;
}

const fits = (s: string) => [...s].length <= MAX_GROUP_NAME_LENGTH && utf8Bytes(s) <= MAX_GROUP_NAME_BYTES;
const splitGraphemes = (s: string) => graphemes ? Array.from(graphemes.segment(s), (g) => g.segment) : [...s];
const lowSurrogate = (s: string, i: number) => { const c = s.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };

/**
 * A change to a group's name field, kept to what `groupName` takes (`fitGroupName`'s count) the way a text field
 * with a limit does: what was typed or pasted goes in at the caret as far as it fits, the rest of it is left out, and
 * the name around it and the caret stay where they were. Cutting the new value's end instead dropped the name's last
 * character, threw the caret to the end and cut what was typed after there (agents#1097). `caret`: where the field's
 * caret is after the change (`selectionStart`).
 */
export function fitGroupNameEdit(before: string, after: string, caret: number | null): { value: string; caret: number } {
  if (fits(after)) return { value: after, caret: caret ?? after.length };
  // The text before and after the change, in both: what lies between in `after` is what was put in.
  const end = Math.max(0, Math.min(caret ?? after.length, after.length));
  let head = 0;
  while (head < before.length && head < end && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - end && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  // Never between the two halves of a character.
  while (head > 0 && lowSurrogate(after, head)) head--;
  while (tail > 0 && lowSurrogate(after, after.length - tail)) tail--;
  const start = after.slice(0, head), rest = after.slice(after.length - tail), put = after.slice(head, after.length - tail);
  if (!fits(start + rest)) return { value: fitGroupName(after), caret: fitGroupName(after).length };
  let kept = "";
  for (const part of splitGraphemes(put)) {
    if (!fits(start + kept + part + rest)) break;
    kept += part;
  }
  return { value: start + kept + rest, caret: start.length + kept.length };
}

export const memberName = (m: { key: string; me: boolean; nick?: string }, t: Translate = english) =>
  m.me ? t("group.member.you") : m.nick || t("group.member.unnamed", { key: publicKeyLabel(m.key) });

/**
 * Who wrote (or reacted to) a group's message: a member by the roster's name; an author no longer in the roster
 * (removed, or back with a new member key) by the name the group knew them by, else by their key.
 */
export const authorName = (group: { members: readonly Pick<GroupMemberView, "key" | "me" | "nick">[]; formerNames?: GroupView["formerNames"] }, key: string, t: Translate = english) => {
  const member = group.members.find(m => m.key === key);
  return member ? memberName(member, t) : group.formerNames?.[key] || t("group.member.unnamed", { key: key.slice(0, 8) });
};

/**
 * A member's picture, when this app has one: mine, or what a member who is also a contact sent in our chat (the
 * identity they are shown as wins, as in the chat). Community members are not contacts: they have none here.
 */
export function memberPhoto(
  group: Pick<GroupView, "memberLinks">, member: { key: string; me: boolean }, links: readonly Pick<LinkView, "id" | "peerPubKeyZ32" | "peerAvatar">[] | undefined,
  faceOf: (peerKey: string | undefined) => { photo?: string } | undefined, myAvatar?: string,
): string | undefined {
  if (member.me) return myAvatar || undefined;
  const linkId = Object.keys(group.memberLinks).find(id => group.memberLinks[id] === member.key);
  const link = linkId ? links?.find(l => l.id === linkId) : undefined;
  return link ? faceOf(link.peerPubKeyZ32)?.photo ?? link.peerAvatar : undefined;
}

/** A group's state in a word, where it is not active: the header's line under the name, the members panel. */
export function groupStatusText(status: NonNullable<GroupView["status"]>, t: Translate = english): string {
  if (status === "left") return t("group.status.left");
  if (status === "removed") return t("group.status.removed");
  if (status === "forked") return t("group.status.forked");
  if (status === "lost") return t("group.status.lost");
  return t("group.status.active");
}

/** A member's edge in a few words: reachable over what, or since when not. `since` writes "3 min ago" in the interface's language. */
export function edgeLabel(member: GroupMemberView, now = Date.now(), t: Translate = english, since: (seconds: number, now: number) => string = ago): string {
  if (member.me) return t("group.member.you");
  const edge = member.edge;
  if (edge?.state === "open") return t("group.member.connected", { transport: transportName(edge.transport) });
  // A group past 16 members that runs on hubs: most members are reached through one, not over an edge of mine.
  if (member.viaHub) return t("group.member.viaHub");
  if (!edge) return t("group.member.noConnection");
  if (edge.noSlot) return t("group.member.noSlot");
  if (edge.state === "connecting") return t("group.member.connecting");
  const seen = edge.lastSeenAt ? t("group.member.lastSeen", { time: since(edge.lastSeenAt / 1000, now / 1000) }) : t("group.member.notSeen");
  return edge.state === "error" && !edgeWaits(edge) ? t("group.member.issue", { seen }) : t("group.member.unreachable", { seen });
}

/**
 * What carries the group, in a few words: "2 of 3 live over WebRTC", or each transport counted when edges differ
 * ("3 of 4 live · 2 WebRTC, 1 Iroh"). Undefined while nobody else is reachable. `transport`: the one they share.
 */
export function groupTransports(members: GroupMemberView[], t: Translate = english): { line: string; transport?: PairedTransport } | undefined {
  const others = members.filter(m => !m.me), live = others.filter(m => m.edge?.state === "open");
  if (!live.length) return undefined;
  const counts = new Map<PairedTransport, number>();
  for (const m of live) { const kind = m.edge!.transport ?? "webrtc/1"; counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  // With hubs, the members reached through them count as live; the transports are those of my own edges.
  const hubbed = others.filter(m => m.viaHub && m.edge?.state !== "open").length;
  const head = hubbed ? t("group.transports.liveHubs", { live: live.length + hubbed, total: others.length, hubs: hubbed })
    : t("group.transports.live", { live: live.length, total: others.length });
  if (counts.size === 1) { const [transport] = counts.keys(); return { line: t("group.transports.over", { head, transport: transportName(transport) }), transport }; }
  return { line: t("group.transports.mixed", { head, list: [...counts].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${n} ${transportName(kind)}`).join(", ") }) };
}

/**
 * An edge down for a reason the app gets past by itself: the relays holding back (their budget, one cooling down) or a
 * session dropped (dialled again). Said as a wait, not red (lib/problemText.ts).
 */
export function edgeWaits(edge: GroupEdgeView | undefined): boolean {
  if (edge?.state !== "error") return false;
  return edge.cause === "session" || (edge.cause === "relays" && relayCause(edge.error ?? "")?.kind === "wait");
}

/** The dot beside a member: reachable, on its way, failed, or away. */
export const edgeDot = (member: GroupMemberView) => member.me || member.edge?.state === "open" || member.viaHub ? "bg-accent"
  : edgeWaits(member.edge) ? "bg-text-muted motion-safe:animate-pulse"
  : member.edge?.state === "error" ? "bg-danger" : member.edge?.state === "connecting" ? "bg-text-muted motion-safe:animate-pulse" : "bg-text-muted/50";

/**
 * An invitation, or a first join through a link, answered from its row: lifted out of folders to stay in sight. A group
 * kept here and knocking to get back in (removed from a community, its link opened again) is the group, not that.
 */
export const invitationRow = (group: Pick<GroupView, "invitation" | "status">): boolean => !!group.invitation && !(group.invitation.viaLink && group.status);

/** Where a private group lives in the app: by its id. */
export function groupPath(groupId: string): string {
  return `/group/${encodeURIComponent(groupId)}`;
}

/** The group a `/group/…` address points at, or null. */
export function groupRouteId(pathname: string): string | null {
  const match = pathname.match(/^\/group\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** When the group last had something unread come: another member's message (an engine without the field: any message). */
export function groupUnreadAt(group: { lastMessageAt: number; lastPeerMessageAt?: number }): number {
  return group.lastPeerMessageAt ?? group.lastMessageAt;
}

/** When this device last looked at the group: anything newer is unread. */
export function groupReadAt(groupId: string): number {
  try { return Number(localStorage.getItem(`${getPrefix()}group_read_${groupId}`) ?? 0) || 0; } catch { return 0; }
}
export function markGroupRead(groupId: string, at = Date.now()): void {
  try { localStorage.setItem(`${getPrefix()}group_read_${groupId}`, String(at)); } catch { /* private mode: nothing is remembered */ }
}

/**
 * What this device keeps of a group beside the engine goes with it (left, deleted here, a join called off): what was
 * typed and not sent, the read mark, the mute and the folder, as a chat's go with the chat (storage.ts deleteSession).
 * A community keeps its id, so a draft left behind was in the field again after joining it again.
 */
export function forgetGroupLocal(groupId: string): void {
  setSessionDraft(`group:${groupId}`, "");
  try { localStorage.removeItem(`${getPrefix()}group_read_${groupId}`); } catch { /* storage unavailable */ }
  forgetChatMute(groupChat(groupId));
  setChatFolder(groupChat(groupId), undefined);
}

/** The web app opens a group's link; the extension and desktop hand out the public app's address, which they also accept pasted. */
const PUBLIC_APP = "https://app.ghostly.tools";
function linkOrigin(): string {
  return /^https?:$/.test(window.location.protocol) ? window.location.origin : PUBLIC_APP;
}

/** The address a group's link opens (`group1/…` for a private group, `group2/…` for a community), or "" while it is off. */
export function groupLinkUrl(group: { entryLink?: string }): string {
  if (!group.entryLink) return "";
  const mesh = decodeGroupEntryLink(group.entryLink);
  if (mesh) return groupEntryUrl(linkOrigin(), mesh);
  return decodeCommunityLink(group.entryLink) ? `${linkOrigin().replace(/\/+$/, "")}/#/join/${group.entryLink}` : "";
}
