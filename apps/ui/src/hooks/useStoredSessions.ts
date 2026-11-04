import { useEffect, useState } from "react";

/** How often the chats are read again without being told of a change (the chat list's pace, `Sidebar`). */
const REFRESH_MS = 3000;

/**
 * The app's chats (1:1, kept by the page) as `read` sees them, read again when one changes (`session-updated`) and
 * every few seconds besides: a message that comes in a background chat, or in the open one, is stored without the
 * event, and the chat list allows for that the same way. `same` tells a reading from the one before, so a read that
 * found nothing new keeps the value it had, and nothing that depends on it does anything. Both are given once (module
 * functions): a new one would start the reading over.
 */
export function useStoredSessions<T>(read: () => T, same: (next: T, before: T) => boolean): T {
  const [sessions, setSessions] = useState(read);
  useEffect(() => {
    const refresh = () => setSessions((before) => { const next = read(); return same(next, before) ? before : next; });
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener("session-updated", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("session-updated", refresh);
    };
  }, [read, same]);
  return sessions;
}
