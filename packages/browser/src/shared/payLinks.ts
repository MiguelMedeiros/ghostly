/**
 * The desk's links to members of a community group (WISP 9xx · Group Community § Payments): payments with a member
 * go through the group, sealed to them, over `cpay:<group>:<member>`; a request to everyone over `cpay:<group>`.
 */
export const pairLinkId = (groupId: string, member: string) => `cpay:${groupId}:${member}`;
export const groupLinkId = (groupId: string) => `cpay:${groupId}`;
/** The group and member of a community payment link, or undefined for any other link. */
export function parsePayLink(linkId: string): { groupId: string; member?: string } | undefined {
  const m = /^cpay:([A-Za-z0-9_-]{22})(?::([a-z0-9]{52}))?$/.exec(linkId);
  return m ? { groupId: m[1], ...(m[2] ? { member: m[2] } : {}) } : undefined;
}
