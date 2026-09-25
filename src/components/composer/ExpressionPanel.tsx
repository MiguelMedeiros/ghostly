import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { useLockScreen } from "../../contexts/LockScreenContext";
import { useOutsideDismiss } from "../../hooks/useDismiss";
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

/**
 * Emoji and GIFs in one panel, as WhatsApp has them: category icons and a search field on top, the grid, and a
 * switch between the two at the bottom that is remembered per profile. On a wide screen it floats over the
 * composer, inside the chat's column however narrow that is; on a phone it is a sheet over the keyboard's place.
 */
export function ExpressionPanel({ boundsRef, dismissRef, onEmoji, onGif, onClose }: {
  /** The composer: the panel stands on it and never runs past its sides. */
  boundsRef: RefObject<HTMLElement | null>;
  /** Clicks in here (the button that opens the panel, the message field) do not close it. */
  dismissRef: RefObject<HTMLElement | null>;
  onEmoji: (emoji: string) => void;
  onGif: (url: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const { isLocked } = useLockScreen();
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState(lastExpressionTab);
  const [position, setPosition] = useState<CSSProperties>();
  const [switched, setSwitched] = useState(false);
  useOutsideDismiss(ref, !isLocked, onClose, dismissRef);

  useLayoutEffect(() => {
    const bounds = boundsRef.current;
    if (!bounds) return;
    const place = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (phone) {
        setPosition({ left, right: "auto", width, bottom: Math.max(0, window.innerHeight - top - height), maxHeight: height * 0.82,
          "--expression-height": `${Math.round(height * 0.52)}px` } as CSSProperties);
        return;
      }
      const rect = bounds.getBoundingClientRect();
      const panelWidth = Math.max(0, Math.min(WIDTH, rect.width - MARGIN * 2, width - MARGIN * 2));
      const panelHeight = Math.max(0, Math.min(HEIGHT, rect.top - top - GAP - MARGIN));
      setPosition({ position: "fixed", zIndex: 60, width: panelWidth, height: panelHeight, top: rect.top - GAP - panelHeight,
        left: Math.max(left + MARGIN, Math.min(rect.left + MARGIN, left + width - panelWidth - MARGIN)) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(bounds);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
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
  return createPortal(<>
    {phone && <div className="sheet-backdrop" />}
    <div ref={ref} role="dialog" aria-label={t("composer.expressions")} data-testid="expression-panel" data-tab={tab}
      className={`expression-panel ${phone ? "sheet expression-sheet" : "expression-popover"}`} style={position ?? { visibility: "hidden" }}>
      {tab === "emoji"
        ? <EmojiTab key="emoji" onPick={onEmoji} autoFocus={switched && !phone} />
        : <GifTab key="gif" onSelect={onGif} autoFocus={!phone} />}
      <div role="tablist" aria-label={t("composer.expressions")} className="expression-switch" onKeyDown={tabKeys}>
        {TABS.map((id) => (
          <button key={id} type="button" role="tab" data-testid={`expression-tab-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
            aria-label={t(`composer.${id}` as const)} title={t(`composer.${id}` as const)} onClick={() => choose(id)}>
            {id === "emoji" ? <SmileIcon size={20} /> : <GifIcon size={20} />}
          </button>
        ))}
      </div>
    </div>
  </>, document.body);
}
