import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/shareLink";

export type MessageCopyNote = { said: "copied" | "failed"; text: string };

/**
 * Copy under a long press on a message (its words are not selectable on a touch screen), and what it says after
 * (components/chat/MessageCopy.tsx): "Copied" for a moment once the text is on the clipboard, or that it could not be,
 * with the text to select by hand. The focus goes back to the message (`back`, its ⋮) as the bar closes, not to the
 * page.
 */
export function useMessageCopy(back: () => HTMLElement | null | undefined): [MessageCopyNote | null, (text: string) => void] {
  const [note, setNote] = useState<MessageCopyNote | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    clearTimeout(timer.current);
    setNote(null);
    back()?.focus({ preventScroll: true });
    void copyText(text).then(() => {
      setNote({ said: "copied", text });
      timer.current = setTimeout(() => setNote(null), 1500);
    }, () => setNote({ said: "failed", text }));
  };
  return [note, copy];
}
