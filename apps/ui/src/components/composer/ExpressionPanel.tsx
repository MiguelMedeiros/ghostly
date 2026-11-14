import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { useLockScreen } from "../../contexts/LockScreenContext";
import { useOutsideDismiss, useTabTrap } from "../../hooks/useDismiss";
import { useIsMobile } from "../../hooks/useIsMobile";
import { getPrefix } from "../../lib/storage";
import { EmojiTab } from "./EmojiTab";
import { GifTab } from "./GifTab";
import { GifIcon, SmileIcon } from "./icons";

export type ExpressionTab = "emoji" | "gif";
const TABS: ExpressionTab[] = ["emoji", "gif"];

const tabKey = () => `${getPrefix()}composer_panel_tab`;
/** The segment this profile last had open. */
function lastExpressionTab(): ExpressionTab {
  try { return localStorage.getItem(tabKey()) === "gif" ? "gif" : "emoji"; } catch { return "emoji"; }
}
function rememberTab(tab: ExpressionTab) {
  try { localStorage.setItem(tabKey(), tab); } catch { /* opens on emoji next time */ }
}

const MARGIN = 8, GAP = 8, WIDTH = 460, HEIGHT = 440;
/** The sheet's categories, search and switch take about 160 px: below this a phone on its side shows no emoji row. */
const SHEET_FLOOR = 290;
/**
 * With the keyboard up (typing a search), a visible height under this leaves the usual panel fewer than two whole rows
 * of 44 px emoji, whichever way the phone is held: the panel goes compact (`data-compact`), the search with the switch
 * beside it over the results, as tall as the screen above the keyboard.
 * The usual phone sheet takes 82% of the visible height, and its chrome about 210 px: the top border 1, the grabber
 * 16 (8 + 4 + 4), the categories 46 (2 + 44), the search row 50 (10 + 36 + 4), the results' heading 34 (10 + 19.5 + 4)
 * and the list's 8 px bottom padding, the tab's border 1, the switch 54 (8 + 3 + 32 + 3 + 8). Two rows need
 * 210 + 2 × 44 = 298 px of sheet, 298 / 0.82 ≈ 364 px visible. So the smallest phone upright (320 × 568, 253 px
 * keyboard: 315 px, one row) and a phone on its side (175 px, none) go compact; a 375 × 667 one upright (260 px
 * keyboard: 407 px, a 334 px sheet, two rows) keeps the usual panel. The two-pane popover has no grabber but stands
 * on the composer, which takes about as much: the same height holds there.
 */
export const COMPACT_BELOW = 364;

/**
 * Emoji and GIFs in one panel, as WhatsApp has them: category icons and a search field on top, the grid, and a
 * switch between the two at the bottom that is remembered per profile. On a wide screen it floats over the
 * composer, inside the chat's column however narrow that is; on a phone it is a sheet over the keyboard's place.
 */
export function ExpressionPanel({ boundsRef, dismissRef, onEmoji, onGif, onClose, focusOnOpen }: {
  /** The composer: the panel stands on it and never runs past its sides. */
  boundsRef: RefObject<HTMLElement | null>;
  /** Clicks in here (the button that opens the panel, the message field) do not close it. */
  dismissRef: RefObject<HTMLElement | null>;
  onEmoji: (emoji: string) => void;
  onGif: (url: string) => void;
  onClose: () => void;
  /** Opened from the keyboard: the emoji search takes the focus, as it does after a switch from GIFs. */
  focusOnOpen?: boolean;
}) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const { isLocked } = useLockScreen();
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState(lastExpressionTab);
  const [position, setPosition] = useState<CSSProperties>();
  const [switched, setSwitched] = useState(false);
  const [compact, setCompact] = useState(false);
  useOutsideDismiss(ref, !isLocked, onClose, dismissRef);
  // On a phone it is a sheet over a backdrop, as the composer's + and the message menus: Tab stays in it.
  useTabTrap(ref, phone && !isLocked);

  useLayoutEffect(() => {
    const bounds = boundsRef.current;
    if (!bounds) return;
    // A new object would render the panel again for nothing: only a position that changed is set.
    let last = "";
    const set = (next: CSSProperties) => {
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setPosition(next); }
    };
    let short = false;
    const place = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const keyboard = document.documentElement.dataset.keyboard === "true";
      // Compact while the keyboard is up, the usual panel would show fewer than two rows of results (COMPACT_BELOW)
      // and the focus is in the panel (its search). A tap on its switch or an emoji can leave the focus nowhere for a
      // moment: it stays compact until the keyboard goes down, so nothing moves under the finger. A field outside it
      // (the message) gets the usual panel back.
      const focused = document.activeElement;
      const inside = !!focused && !!ref.current?.contains(focused);
      const nowhere = !focused || focused === document.body;
      short = keyboard && height < COMPACT_BELOW && (inside || (short && nowhere));
      setCompact(short);
      if (phone) {
        // With the keyboard up (a search), half of what it leaves is a strip of results: take all the sheet may.
        // On a short screen (a phone on its side) half is too little for any emoji row: take up to SHEET_FLOOR.
        // Compact, it takes what the keyboard leaves, less a strip of the backdrop that closes it.
        const most = short ? height - MARGIN : height * 0.82;
        const sheet = keyboard ? most : Math.max(height * 0.52, Math.min(height * 0.82, SHEET_FLOOR));
        set({ left, right: "auto", width, bottom: Math.max(0, window.innerHeight - top - height), maxHeight: most,
          "--expression-height": `${Math.round(sheet)}px` } as CSSProperties);
        return;
      }
      const rect = bounds.getBoundingClientRect();
      const panelWidth = Math.max(0, Math.min(WIDTH, rect.width - MARGIN * 2, width - MARGIN * 2));
      const panelLeft = Math.max(left + MARGIN, Math.min(rect.left + MARGIN, left + width - panelWidth - MARGIN));
      if (short) {
        // Over the composer, which nobody types into meanwhile: above it, the keyboard leaves no room for a row.
        set({ position: "fixed", zIndex: 60, width: panelWidth, height: Math.max(0, height - MARGIN * 2), top: top + MARGIN, left: panelLeft });
        return;
      }
      const panelHeight = Math.max(0, Math.min(HEIGHT, rect.top - top - GAP - MARGIN));
      set({ position: "fixed", zIndex: 60, width: panelWidth, height: panelHeight, top: rect.top - GAP - panelHeight, left: panelLeft });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(bounds);
    // One measure a frame however many events come; a scroll inside the panel (its grid) does not move it.
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    const scrolled = (e: Event) => { if (!ref.current?.contains(e.target as Node)) later(); };
    window.addEventListener("resize", later);
    window.addEventListener("scroll", scrolled, true);
    window.visualViewport?.addEventListener("resize", later);
    window.visualViewport?.addEventListener("scroll", later);
    // The focus going into the search or out of the panel can change the compact layout with no resize.
    document.addEventListener("focusin", place);
    document.addEventListener("focusout", later);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("focusin", place);
      document.removeEventListener("focusout", later);
      window.removeEventListener("resize", later);
      window.removeEventListener("scroll", scrolled, true);
      window.visualViewport?.removeEventListener("resize", later);
      window.visualViewport?.removeEventListener("scroll", later);
    };
  }, [boundsRef, phone]);

  const choose = (next: ExpressionTab) => { setTab(next); rememberTab(next); setSwitched(true); };
  const tabKeys = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length];
    choose(next);
    ref.current?.querySelector<HTMLElement>(`[data-testid="expression-tab-${next}"]`)?.focus();
  };

  // A portal keeps it clear of the composer's and the sidebar's clipping. The app is inert under the lock
  // screen, but a portal is outside the app: it stays closed while locked.
  if (isLocked) return null;
  // Hidden until placed, and a browser focuses nothing hidden: a search takes the focus only from then on.
  const placed = position !== undefined;
  return createPortal(<>
    {phone && <div className="sheet-backdrop" />}
    <div ref={ref} role="dialog" aria-label={t("composer.expressions")} data-testid="expression-panel" data-tab={tab}
      className={`expression-panel ${phone ? "sheet expression-sheet" : "expression-popover"}`} data-compact={compact || undefined}
      style={position ?? { visibility: "hidden" }}>
      {tab === "emoji"
        ? <EmojiTab key="emoji" onPick={onEmoji} autoFocus={(switched || focusOnOpen) && !phone && placed} />
        : <GifTab key="gif" onSelect={onGif} onEmojiTab={() => choose("emoji")} autoFocus={!phone && placed} />}
      <div role="tablist" aria-label={t("composer.expressions")} className="expression-switch" onKeyDown={tabKeys}>
        {TABS.map((id) => (
          <button key={id} type="button" role="tab" className="tap-target" data-testid={`expression-tab-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
            aria-label={t(`composer.${id}` as const)} title={t(`composer.${id}` as const)} onClick={() => choose(id)}>
            {id === "emoji" ? <SmileIcon size={20} /> : <GifIcon size={20} />}
          </button>
        ))}
      </div>
    </div>
  </>, document.body);
}
