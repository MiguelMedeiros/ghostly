import { useCallback, useEffect, useRef, useState } from "react";
import { ANNOUNCE_CLEAR_MS } from "../components/chat/MessageAnnouncer";
import { useI18n } from "../contexts/I18nContext";
import type { PinnedPlace } from "../lib/storage";

/** The line a screen reader hears after a move, and what says it: `[text, announce]`. It empties, so the same place twice is said twice. */
export function usePinMoveNote(): [string, (place: PinnedPlace | undefined) => void] {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const announce = useCallback((place: PinnedPlace | undefined) => {
    if (!place) return;
    setText(t("chat.announce.pinMoved", { place: place.index + 1, count: place.count }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(""), ANNOUNCE_CLEAR_MS);
  }, [t]);
  return [text, announce];
}
