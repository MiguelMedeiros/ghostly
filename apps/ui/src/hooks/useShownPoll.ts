import { useEffect, useRef, useState } from "react";

/*
 * Something the engine is asked for again and again because a screen shows it (a handoff's progress, the device set).
 * A screen nobody can see needs no fresh answer: the timer stops while the page is hidden (the Desktop window closed to
 * the Dock or minimised, a browser tab in the background), and the page back in front asks once and starts it again.
 * An answer that says what the last one said is not news: the value held stays the same object, so nothing draws again.
 */

/**
 * What `read` answers: asked when `on` begins, then every `everyMs` while the page shows (0: only that once). Null
 * until the first answer; a failed read keeps what was held.
 */
export function useShownPoll<T>(read: () => Promise<T>, everyMs: number, on = true): T | null {
  const [value, setValue] = useState<T | null>(null);
  const reader = useRef(read);
  reader.current = read;
  // What the value held says, as text: two answers are the same when this is.
  const said = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ask = () => void reader.current().then((next) => {
      if (!live) return;
      const text = JSON.stringify(next);
      if (text === said.current) return;
      said.current = text;
      setValue(next);
    }, () => {});
    ask();
    if (everyMs <= 0) return () => { live = false; };
    const shown = () => document.visibilityState !== "hidden";
    const run = () => { timer ??= setInterval(ask, everyMs); };
    const changed = () => {
      if (!shown()) { clearInterval(timer); timer = undefined; return; }
      if (timer !== undefined) return;
      ask();
      run();
    };
    if (shown()) run();
    document.addEventListener("visibilitychange", changed);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", changed); };
  }, [on, everyMs]);
  return value;
}
