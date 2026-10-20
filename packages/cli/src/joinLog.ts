/**
 * A join through a group's link, as a daemon says it in its log (stderr): the steps of the knock and of the entry
 * session, one short line each, from the engine's join trace (packages/browser/src/engine/joinTrace.ts). Without them a
 * join that stalled left nothing in the admin's log to tell a knock never seen from a session that never opened
 * (2026-10-16). The reads of the knocks, every few seconds, and an edge's own steps are not said.
 */
const SAID: Record<string, string> = {
  "join.start": "joining through its link",
  "knock.published": "knock left",
  "knock.seen": "a knock seen: opening an entry session",
  "link.start": "entry session starting",
  "link.presence": "entry session: the other side's packet seen",
  "link.offering": "entry session: offering a connection",
  "link.answering": "entry session: answering a connection",
  "link.connecting": "entry session: connecting",
  "link.open": "entry session open",
  "link.idle": "entry session not open",
  "link.native": "entry session: WebRTC connected nothing, going on over a native transport",
  "invite.sent": "invitation sent on the entry session",
  "invite.received": "invitation received on the entry session: accepting",
  "welcome.sent": "welcome sent",
  "welcome.received": "welcome received: in the group",
};

/** The log line for one join-trace line, or null when it is not said. */
export function joinLogLine(traced: string): string | null {
  let step: { t?: unknown; g?: unknown; step?: unknown; role?: unknown };
  try { step = JSON.parse(traced) as typeof step; } catch { return null; }
  if (typeof step.step !== "string" || typeof step.g !== "string" || !Object.hasOwn(SAID, step.step)) return null;
  // A link's steps are an entry session's only: an edge's go to the link trace.
  const role = step.role === "host" || step.role === "guest" ? step.role : undefined;
  if (step.step.startsWith("link.") && !role) return null;
  const at = typeof step.t === "number" ? ` at ${new Date(step.t).toISOString()}` : "";
  return `ghostly: group ${step.g}: ${SAID[step.step]}${role ? ` (${role === "host" ? "letting in" : "joining"})` : ""}${at}`;
}
