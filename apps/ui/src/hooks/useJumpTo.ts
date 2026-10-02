import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { userState } from "../lib/navigation";
import { jumpToCard } from "../lib/replies";

/** The router state a page opens a chat or group with to land on one of its messages: `{ [JUMP_TO]: messageId }`. */
export const JUMP_TO = "jumpTo";

/**
 * A chat or group opened on a card's message (the Tasks board's click: `nav.conversation(path, { jumpTo })`): once the
 * message is among the chat's (`has`), the timeline goes to it and marks it, as a row of the chat's own Tasks panel
 * does. Once per visit of that history entry; `active`: this chat is the one on screen.
 */
export function useJumpTo(active: boolean, has: (messageId: string) => boolean): void {
  const location = useLocation();
  const target = active ? userState(location.state)?.[JUMP_TO] : undefined;
  const done = useRef("");
  useEffect(() => {
    if (typeof target !== "string") return;
    const visit = `${location.key}\n${target}`;
    if (done.current === visit || !has(target)) return;
    done.current = visit;
    // A frame later: this draw's rows are in the page and the chat has taken its place at the bottom.
    requestAnimationFrame(() => { jumpToCard(target); });
  });
}
