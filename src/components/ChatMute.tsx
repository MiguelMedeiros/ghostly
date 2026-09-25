import type { RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { MUTE_CHOICES, muteEnd, muteEndText, setChatMute, useChatMute, type MutedUntil } from "../lib/chatMute";
import { Menu, MenuItem } from "./Menu";

/*
 * A chat's notifications, muted for a while or until turned back on (src/lib/chatMute.ts): the row in the
 * chat's ⋮ menu and the menu of durations (the list's mark, and the bell button over it, are ChatRow's). `chat`
 * is a session id, or `groupChat(id)` for a group.
 */

export function BellIcon({ muted = false, size = 14 }: { muted?: boolean; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      {muted ? <>
        <path d="M18.63 13A17.9 17.9 0 0 1 18 8" />
        <path d="M6.26 6.26A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14" />
        <path d="M18 8a6 6 0 0 0-9.33-5" />
        <path d="M2 2l20 20" />
      </> : <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />}
    </svg>
  );
}

/** "Muted until 14:30", or "Muted" when it has no end. */
function useMutedText() {
  const { t, language } = useI18n();
  return (until: MutedUntil) => until === "forever" ? t("mute.muted") : t("mute.mutedUntil", { time: muteEndText(until, language) });
}

/**
 * The chat's ⋮ menu row: "Mute notifications…" opens the durations (`onChoose`); while muted, "Unmute
 * notifications" with until when, which unmutes at once.
 */
export function MuteMenuItem({ chat, onChoose, onDone }: { chat: string; onChoose(): void; onDone(): void }) {
  const { t } = useI18n();
  const until = useChatMute(chat);
  const mutedText = useMutedText();
  if (until === undefined) return <MenuItem testId="chat-mute-open" icon={<BellIcon />} onClick={onChoose}>{t("mute.open")}</MenuItem>;
  return (
    <MenuItem testId="chat-unmute" icon={<BellIcon muted />} hint={mutedText(until)} onClick={() => { setChatMute(chat, undefined); onDone(); }}>
      {t("mute.unmute")}
    </MenuItem>
  );
}

/**
 * How long to mute the chat for, each choice with the time it ends. Once muted (opened from the list row's bell),
 * until when, and the way back. `portal`: for an opener in the chat list (Menu's `portal`).
 */
export function MuteMenu({ chat, open, onClose, anchorRef, align, portal }: {
  chat: string; open: boolean; onClose(): void; anchorRef: RefObject<HTMLElement | null>; align?: "start" | "end"; portal?: boolean;
}) {
  const { t, language } = useI18n();
  const until = useChatMute(chat);
  const mutedText = useMutedText();
  const now = Date.now();
  const hint = (choice: (typeof MUTE_CHOICES)[number]) => {
    const end = muteEnd(choice, now);
    return end === "forever" ? t("mute.noEnd") : t("mute.until", { time: muteEndText(end, language, now) });
  };
  return (
    <Menu testId="mute-menu" open={open} onClose={onClose} anchorRef={anchorRef} align={align} portal={portal} focusFirst label={until === undefined ? t("mute.title") : mutedText(until)}>
      {/* Not a row: the note may wrap on a narrow sheet rather than be cut. */}
      <div className="px-3 pb-1 pt-1.5 text-xs text-text-muted" data-testid="mute-menu-head">
        <span className="block truncate whitespace-nowrap font-medium text-text-primary">{until === undefined ? t("mute.title") : mutedText(until)}</span>
        <span className="block">{t("mute.stillArrive")}</span>
      </div>
      {until === undefined
        ? MUTE_CHOICES.map(choice => (
          <MenuItem key={choice} testId={`mute-${choice}`} hint={hint(choice)} onClick={() => { setChatMute(chat, muteEnd(choice)); onClose(); }}>
            {t(`mute.choice.${choice}`)}
          </MenuItem>
        ))
        : <MenuItem testId="mute-off" icon={<BellIcon />} onClick={() => { setChatMute(chat, undefined); onClose(); }}>{t("mute.unmute")}</MenuItem>}
    </Menu>
  );
}
