/**
 * A word about a join that opened an existing chat instead of making one: "You're already in this
 * chat", or "This is your own invite" from a link. Whoever handled the join says it; `JoinNotice` in
 * Root shows it over the chat for a moment.
 */
export type JoinNoticeKey = "join.own" | "join.alreadyIn";

const EVENT = "ghostly-join-notice";

export function showJoinNotice(key: JoinNoticeKey): void {
  window.dispatchEvent(new CustomEvent<JoinNoticeKey>(EVENT, { detail: key }));
}

export function onJoinNotice(listener: (key: JoinNoticeKey) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<JoinNoticeKey>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
