import { useEffect, useRef, useState, type RefObject } from "react";
import { QUICK_REACTIONS, reactionEmoji } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { Menu } from "../Menu";
import { EmojiTab } from "../composer/EmojiTab";
import { SmileIcon } from "../composer/icons";
import type { ReactionChip } from "../../lib/reactions";

/*
 * Reactions to a message (WISP 400 § Reactions), as the chat shows them: a quick bar of six and "+" for any emoji,
 * and chips under the bubble, one per emoji, with who reacted.
 */

/** How long a pointer rests on a chip before its names show; a touch held this long shows them instead of a toggle. */
const WHO_DELAY = 300, WHO_PRESS = 450;

/**
 * The chips under a bubble. A click on mine takes it back; on another's emoji, reacts with the same. The names show
 * on hover, on focus, or on a long press (whose click is then not a toggle).
 */
export function ReactionChips({ chips, onReact, align }: { chips: ReactionChip[]; onReact?: (emoji: string) => void; align: "start" | "end" }) {
  const { t } = useI18n();
  const [who, setWho] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!chips.length) return null;
  const later = (emoji: string, ms: number, then?: () => void) => { clearTimeout(timer.current); timer.current = setTimeout(() => { then?.(); setWho(emoji); }, ms); };
  const hide = () => { clearTimeout(timer.current); setWho(null); };
  return (
    <div data-testid="reaction-chips" className={`relative flex flex-wrap gap-1 mt-[-6px] mb-1 z-[1] ${align === "end" ? "justify-end" : "justify-start"}`}>
      {chips.map(chip => {
        const label = t("chat.reactions.chipLabel", { emoji: chip.emoji, names: chip.who.join(", ") });
        return (
          <span key={chip.emoji} className="relative">
            <button type="button" data-testid="reaction-chip" data-emoji={chip.emoji} data-mine={chip.mine || undefined} aria-pressed={chip.mine} aria-label={label}
              disabled={!onReact}
              onPointerEnter={e => { if (e.pointerType === "mouse") later(chip.emoji, WHO_DELAY); }}
              onPointerLeave={e => { if (e.pointerType === "mouse") hide(); }}
              onPointerDown={e => { if (e.pointerType !== "mouse") { held.current = false; later(chip.emoji, WHO_PRESS, () => { held.current = true; }); } }}
              onPointerUp={e => { if (e.pointerType !== "mouse") clearTimeout(timer.current); }}
              onFocus={e => { try { if (e.currentTarget.matches(":focus-visible")) setWho(chip.emoji); } catch { setWho(chip.emoji); } }}
              onBlur={hide}
              onContextMenu={e => { if (held.current) e.preventDefault(); }}
              onClick={e => {
                // A long press showed the names: that is all it did.
                if (held.current) { held.current = false; e.preventDefault(); return; }
                hide();
                onReact?.(chip.mine ? "" : chip.emoji);
              }}
              className={`inline-flex items-center gap-1 h-6 px-1.5 rounded-full border text-[13px] leading-none shadow-sm transition-colors cursor-pointer disabled:cursor-default ${
                chip.mine ? "border-accent bg-accent/20 text-text-primary" : "border-border bg-surface-alt text-text-secondary hover:bg-surface-hover"}`}>
              <span aria-hidden="true">{chip.emoji}</span>
              {chip.count > 1 && <span data-testid="reaction-count" aria-hidden="true" className="text-[11px] tabular-nums">{chip.count}</span>}
            </button>
            {who === chip.emoji && (
              <span role="tooltip" data-testid="reaction-who" className={`absolute bottom-full mb-1 z-20 w-max max-w-[14rem] rounded-md border border-border bg-surface-alt px-2 py-1 text-xs text-text-primary shadow-lg whitespace-normal ${align === "end" ? "end-0" : "start-0"}`}>
                <span aria-hidden="true" className="me-1">{chip.emoji}</span>{chip.who.join(", ")}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** React, beside a message, for a pointer: shown while the message is hovered or the button has the focus. */
export function ReactAction({ onOpen, anchorRef, open }: { onOpen: () => void; anchorRef: RefObject<HTMLSpanElement | null>; open: boolean }) {
  const { t } = useI18n();
  return (
    <span ref={anchorRef} className="self-center shrink-0 relative max-md:hidden">
      <button type="button" data-testid="message-react-action" onClick={onOpen} title={t("chat.reactions.react")} aria-label={t("chat.reactions.react")}
        aria-haspopup="true" aria-expanded={open}
        className={`p-1 rounded-full text-text-muted hover:text-text-primary transition-all cursor-pointer md:group-hover:opacity-100 md:focus-visible:opacity-100 ${open ? "opacity-100" : "md:opacity-0"}`}>
        <SmileIcon size={16} />
      </button>
    </span>
  );
}

/**
 * The quick bar: six reactions and "+" for any emoji (the composer's emoji panel). The one I chose is marked, and
 * choosing it again takes it back. `onDetails`: a Details button too (a long press opens the bar on phones, where it
 * used to open the details).
 */
export function ReactionBar({ open, onClose, anchorRef, current, onReact, align, onDetails }: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** My reaction now ("" for none). */
  current: string;
  onReact: (emoji: string) => void;
  align: "start" | "end";
  onDetails?: () => void;
}) {
  const { t } = useI18n();
  const [more, setMore] = useState(false);
  useEffect(() => { if (!open) setMore(false); }, [open]);
  const choose = (emoji: string) => {
    const e = reactionEmoji(emoji);
    if (!e) return;
    onClose();
    onReact(e === current ? "" : e);
  };
  return <>
    <Menu open={open && !more} onClose={onClose} anchorRef={anchorRef} testId="reaction-bar" align={align} prefer="up" portal within="[data-message-list]" focusFirst label={t("chat.reactions.react")}>
      <div role="toolbar" aria-label={t("chat.reactions.react")} className="flex items-center gap-0.5 px-1"
        onKeyDown={e => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const all = [...e.currentTarget.querySelectorAll<HTMLElement>("button")];
          const at = all.indexOf(document.activeElement as HTMLElement), rtl = getComputedStyle(e.currentTarget).direction === "rtl";
          const step = (e.key === "ArrowRight") !== rtl ? 1 : -1;
          all[(at + step + all.length) % all.length]?.focus();
          e.preventDefault();
        }}>
        {QUICK_REACTIONS.map(emoji => (
          <button key={emoji} type="button" data-testid="reaction-quick" data-emoji={emoji} aria-pressed={current === emoji} aria-label={emoji} title={emoji}
            onClick={() => choose(emoji)}
            className={`w-9 h-9 max-md:w-11 max-md:h-11 rounded-full text-[22px] leading-none flex items-center justify-center transition-transform hover:scale-125 hover:bg-surface-hover cursor-pointer ${current === emoji ? "bg-accent/25" : ""}`}>
            {emoji}
          </button>
        ))}
        <button type="button" data-testid="reaction-more" aria-label={t("chat.reactions.more")} title={t("chat.reactions.more")} onClick={() => setMore(true)}
          className="w-9 h-9 max-md:w-11 max-md:h-11 rounded-full flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover cursor-pointer">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      {onDetails && (
        <button type="button" data-testid="reaction-bar-details" onClick={() => { onClose(); onDetails(); }}
          className="mt-1 w-full px-3 py-2 text-start text-sm text-text-secondary hover:bg-surface-hover cursor-pointer border-t border-border">
          {t("chat.message.details")}
        </button>
      )}
    </Menu>
    <Menu open={open && more} onClose={onClose} anchorRef={anchorRef} testId="reaction-picker" align={align} prefer="up" portal within="[data-message-list]" label={t("chat.reactions.more")}>
      <div className="expression-panel reaction-picker" style={{ width: "min(20rem, calc(100vw - 1rem))", height: 360, border: 0, boxShadow: "none" }}>
        <EmojiTab onPick={choose} autoFocus />
      </div>
    </Menu>
  </>;
}
