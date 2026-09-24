import { getPrefix } from "./storage";
import { publicKeyLabel } from "./publicKeyLabel";

/** How a member is named in a group: their announced name, or their key. */
export const memberName = (m: { key: string; me: boolean; nick?: string }) => m.me ? "You" : m.nick || `Member ${publicKeyLabel(m.key)}`;

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
