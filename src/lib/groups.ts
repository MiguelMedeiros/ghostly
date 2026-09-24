import { decodeCommunityLink, decodeGroupEntryLink, groupEntryUrl } from "@ghostly/core";
import { getPrefix } from "./storage";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { publicKeyLabel } from "./publicKeyLabel";
import { transportName } from "./connection";
import { ago } from "./time";

/** How a member is named in a group: their announced name, or their key. */
export const memberName = (m: { key: string; me: boolean; nick?: string }) => m.me ? "You" : m.nick || `Member ${publicKeyLabel(m.key)}`;

/** A member's edge in a few words: reachable over what, or since when not. */
export function edgeLabel(member: GroupMemberView, now = Date.now()): string {
  if (member.me) return "You";
  const edge = member.edge;
  if (!edge) return "No connection yet";
  if (edge.state === "open") return `Connected · ${transportName(edge.transport)}`;
  if (edge.state === "connecting") return "Connecting…";
  const seen = edge.lastSeenAt ? `last seen ${ago(edge.lastSeenAt / 1000, now / 1000)}` : "not seen yet";
  return `${edge.state === "error" ? "Connection issue" : "Not reachable"} · ${seen}`;
}

/** The dot beside a member: reachable, on its way, failed, or away. */
export const edgeDot = (member: GroupMemberView) => member.me || member.edge?.state === "open" ? "bg-accent"
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
