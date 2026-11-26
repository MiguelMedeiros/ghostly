/**
 * A word about a join that opened an existing chat instead of making one: "You're already in this
 * chat", or "This is your own invite" from a link. Whoever handled the join says it for the chat it
 * opened; `JoinNotice` in Root shows it over that chat for a moment, and never over another one.
 */
export type JoinNoticeKey = "join.own" | "join.alreadyIn";

export type JoinNoticeDetail = { key: JoinNoticeKey; sessionId: string };

const EVENT = "ghostly-join-notice";

export function showJoinNotice(key: JoinNoticeKey, sessionId: string): void {
  window.dispatchEvent(new CustomEvent<JoinNoticeDetail>(EVENT, { detail: { key, sessionId } }));
}

export function onJoinNotice(listener: (notice: JoinNoticeDetail) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<JoinNoticeDetail>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
