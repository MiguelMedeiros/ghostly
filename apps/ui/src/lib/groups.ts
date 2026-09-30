import { decodeCommunityLink, decodeGroupEntryLink, groupEntryUrl, type PairedTransport } from "@ghostly/core";
import { getPrefix } from "./storage";
import type { GroupMemberView, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { publicKeyLabel } from "./publicKeyLabel";
import { transportName } from "./connection";
import { ago } from "./time";
import { english } from "./english";
import type { Translate } from "../contexts/I18nContext";

/** How a member is named in a group: their announced name, or their key. `t`: the interface's words ("You"). */
export const memberName = (m: { key: string; me: boolean; nick?: string }, t: Translate = english) =>
  m.me ? t("group.member.you") : m.nick || t("group.member.unnamed", { key: publicKeyLabel(m.key) });

/**
 * Who wrote (or reacted to) a group's message: a member by the roster's name; an author no longer in the roster
 * (removed, or back with a new member key) by the name the group knew them by, else by their key.
 */
export const authorName = (group: Pick<GroupView, "members" | "formerNames">, key: string, t: Translate = english) => {
  const member = group.members.find(m => m.key === key);
  return member ? memberName(member, t) : group.formerNames?.[key] || t("group.member.unnamed", { key: key.slice(0, 8) });
};

/**
 * A member's picture, when this app has one: mine, or what a member who is also a contact sent in our chat (the
 * identity they are shown as wins, as in the chat). Community members are not contacts: they have none here.
 */
export function memberPhoto(
  group: Pick<GroupView, "memberLinks">, member: { key: string; me: boolean }, links: readonly LinkView[] | undefined,
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
  return edge.state === "error" ? t("group.member.issue", { seen }) : t("group.member.unreachable", { seen });
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

/** The dot beside a member: reachable, on its way, failed, or away. */
export const edgeDot = (member: GroupMemberView) => member.me || member.edge?.state === "open" || member.viaHub ? "bg-accent"
  : member.edge?.state === "error" ? "bg-danger" : member.edge?.state === "connecting" ? "bg-text-muted motion-safe:animate-pulse" : "bg-text-muted/50";

/** Where a private group lives in the app: by its id. */
export function groupPath(groupId: string): string {
  return `/group/${encodeURIComponent(groupId)}`;
}

/** The group a `/group/…` address points at, or null. */
export function groupRouteId(pathname: string): string | null {
  const match = pathname.match(/^\/group\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** When this device last looked at the group: anything newer is unread. */
export function groupReadAt(groupId: string): number {
  try { return Number(localStorage.getItem(`${getPrefix()}group_read_${groupId}`) ?? 0) || 0; } catch { return 0; }
}
export function markGroupRead(groupId: string, at = Date.now()): void {
  try { localStorage.setItem(`${getPrefix()}group_read_${groupId}`, String(at)); } catch { /* private mode: nothing is remembered */ }
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
