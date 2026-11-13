/**
 * A group's unread dot, in the list and on the rail. A dot is its background alone, which forced colors (Windows Contrast)
 * replace with the page's: there it is drawn in the system's colours instead, Highlight, or GrayText in a muted group.
 */
export const unreadDot = (muted: boolean) => `rounded-full forced-colors:forced-color-adjust-none ${muted ? "bg-text-secondary forced-colors:bg-[color:GrayText]" : "bg-accent forced-colors:bg-[color:Highlight]"}`;
