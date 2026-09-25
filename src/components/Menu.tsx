import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useIsMobile } from "../hooks/useIsMobile";

/** Space kept between a menu and the edges of the window. */
const MARGIN = 8;
/** Space between a menu and its opener (mt-1 / mb-1). */
const GAP = 4;

/**
 * A dropdown of actions. Every row is one line in every language: the menu is as wide as its longest row
 * (between a floor and the window), and only a row wider than that is cut, with the full text on hover.
 * On a wide screen it drops from its opener and moves over, or up, to stay in the window; on a phone it is a
 * sheet from the bottom with full-width rows. Outside clicks and Escape close it; the arrow keys, Home and End
 * move between the rows that can be used.
 */
export function Menu({ open, onClose, anchorRef, testId, id, align = "end", prefer = "down", focusFirst, label, portal, within, className = "", children }: {
  open: boolean;
  onClose: () => void;
  /** The opener and its positioned wrapper: the menu drops from its end edge, and clicks on it are not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  testId: string;
  id?: string;
  /** Which edge of the opener the popover lines up with. */
  align?: "start" | "end";
  /** Where it opens when there is room on both sides: under its opener, or over it (as a composer's menu does). */
  prefer?: "down" | "up";
  /** The first usable row takes the focus when the menu opens, so the keys work at once. */
  focusFirst?: boolean;
  /** What a screen reader calls the menu. */
  label?: string;
  /**
   * On a wide screen too, drawn over the whole page (placed by its opener, and following it on scroll) rather than
   * inside the opener's wrapper: for an opener in a scrolling list or a row, which would cut the popover off or
   * draw over it.
   */
  portal?: boolean;
  /**
   * A selector for an ancestor of the opener (a chat's message list) that the popover stays inside as well as the
   * window: it moves over, and flips, within the part of the window that ancestor covers.
   */
  within?: string;
  className?: string;
  children: ReactNode;
}) {
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  useOutsideDismiss(ref, open, onClose, anchorRef);
  const [place, setPlace] = useState<{ shift: number; up: boolean }>({ shift: 0, up: prefer === "up" });
  const [fixed, setFixed] = useState<{ left: number; top: number }>();

  useLayoutEffect(() => {
    if (!open || phone) return;
    const fit = () => {
      const menu = ref.current, anchor = anchorRef.current;
      if (!menu || !anchor) return;
      const box = bounds(anchor, within);
      if (portal) {
        const rect = menu.getBoundingClientRect(), opener = anchor.getBoundingClientRect();
        const below = opener.bottom + rect.height + MARGIN <= box.bottom, above = opener.top - rect.height - MARGIN >= box.top;
        const up = prefer === "up" ? above || !below : !below && above;
        // Lined up with the opener's start or end edge (the end is the left one in a right-to-left page), kept in the bounds.
        const left = (align === "start") === (getComputedStyle(anchor).direction !== "rtl") ? opener.left : opener.right - rect.width;
        const next = { left: Math.max(box.left + MARGIN, Math.min(left, box.right - MARGIN - rect.width)), top: up ? opener.top - GAP - rect.height : opener.bottom + GAP };
        setFixed(was => was?.left === next.left && was.top === next.top ? was : next);
        return;
      }
      // Measured where it would open without any correction.
      const before = menu.style.translate;
      menu.style.translate = "0";
      const rect = menu.getBoundingClientRect(), opener = anchor.getBoundingClientRect();
      const left = box.left + MARGIN, right = box.right - MARGIN;
      const shift = rect.left < left ? left - rect.left : rect.right > right ? Math.max(left - rect.left, right - rect.right) : 0;
      const below = opener.bottom + rect.height + MARGIN <= box.bottom, above = opener.top - rect.height - MARGIN >= box.top;
      const up = prefer === "up" ? above || !below : !below && above;
      menu.style.translate = before;
      setPlace(was => was.shift === shift && was.up === up ? was : { shift, up });
    };
    fit();
    window.addEventListener("resize", fit);
    if (portal) window.addEventListener("scroll", fit, true);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit, true);
    };
  }, [open, phone, anchorRef, prefer, portal, align, within]);

  useEffect(() => {
    if (open && focusFirst) usable(ref.current)[0]?.focus({ preventScroll: true });
  }, [open, focusFirst, phone]);

  if (!open) return null;

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = usable(ref.current);
    if (!rows.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1
      : e.key === "ArrowDown" ? (at + 1) % rows.length : (at <= 0 ? rows.length : at) - 1;
    rows[next].focus();
  };

  if (phone) return createPortal(<>
    <div aria-hidden="true" data-testid="menu-backdrop" className="fixed inset-0 z-50 bg-black/40 animate-fade-in" />
    <div ref={ref} id={id} data-testid={testId} data-menu="sheet" role={label ? "group" : undefined} aria-label={label} onKeyDown={keys}
      className={`menu-sheet fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface-alt px-1 pt-2 pb-safe shadow-2xl animate-fade-in ${className}`}>
      <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-border-bright" />
      {children}
    </div>
  </>, document.body);

  if (portal) return createPortal(
    <div ref={ref} id={id} data-testid={testId} data-menu="popover" role={label ? "group" : undefined} aria-label={label} onKeyDown={keys}
      style={{ left: fixed?.left ?? 0, top: fixed?.top ?? 0 }}
      className={`fixed z-50 w-max min-w-44 max-w-[min(20rem,calc(100vw-1rem))] rounded-lg border border-border bg-surface-alt py-1 shadow-lg animate-fade-in ${className}`}>
      {children}
    </div>, document.body);

  return (
    <div ref={ref} id={id} data-testid={testId} data-menu="popover" role={label ? "group" : undefined} aria-label={label} onKeyDown={keys}
      style={{ translate: place.shift ? `${place.shift}px 0` : undefined } as CSSProperties}
      className={`absolute ${align === "start" ? "start-0" : "end-0"} z-50 w-max min-w-44 max-w-[min(20rem,calc(100vw-1rem))] rounded-lg border border-border bg-surface-alt py-1 shadow-lg animate-fade-in ${place.up ? "bottom-full mb-1" : "top-full mt-1"} ${className}`}>
      {children}
    </div>
  );
}

/** The window, or the part of it the opener's `within` ancestor covers. */
function bounds(anchor: HTMLElement, within?: string) {
  const width = document.documentElement.clientWidth || window.innerWidth, height = window.innerHeight;
  const box = { left: 0, top: 0, right: width, bottom: height };
  const area = within ? anchor.closest(within)?.getBoundingClientRect() : undefined;
  // An ancestor with no size (not laid out) bounds nothing.
  if (!area?.width || !area.height) return box;
  return { left: Math.max(box.left, area.left), top: Math.max(box.top, area.top), right: Math.min(box.right, area.right), bottom: Math.min(box.bottom, area.bottom) };
}

/** The rows the keys move between: those that can be used now. */
const usable = (menu: HTMLElement | null) => [...menu?.querySelectorAll<HTMLElement>("[data-menu-item]:not(:disabled)") ?? []];

/** Shows the whole text on hover only when the row had to cut it. */
function titleIfCut(row: HTMLElement) {
  const cut = [...row.querySelectorAll<HTMLElement>("[data-menu-text]")].some(el => el.scrollWidth > el.clientWidth);
  if (cut) row.title = row.innerText.replace(/\s+/g, " ").trim();
  else row.removeAttribute("title");
}

export function MenuItem({ icon, children, hint, onClick, danger, disabled, title, testId, className = "", data }: {
  icon?: ReactNode;
  children: ReactNode;
  /** A second, quieter line under the label; one line too. */
  hint?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** A row that cannot be used now; its `title` (and hint) say why. */
  disabled?: boolean;
  /** A hover text kept whether or not the row is cut. */
  title?: string;
  testId?: string;
  className?: string;
  /** `data-*` attributes for the row. */
  data?: Record<`data-${string}`, string | number | undefined>;
}) {
  const fitTitle = (row: HTMLElement) => { if (!title) titleIfCut(row); };
  return (
    <button type="button" data-testid={testId} data-menu-item onClick={onClick} disabled={disabled} title={title} {...data}
      onPointerEnter={e => fitTitle(e.currentTarget)} onFocus={e => fitTitle(e.currentTarget)}
      className={`flex w-full min-w-0 items-center whitespace-nowrap px-3 py-2 text-start text-sm transition-colors enabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none disabled:cursor-not-allowed max-md:min-h-12 max-md:rounded-lg ${hint ? "gap-3" : "gap-2"} ${danger ? "text-danger" : hint ? "text-text-primary" : "text-text-secondary hover:text-text-primary"} ${className}`}>
      {icon && <span aria-hidden="true" data-menu-icon className={`flex shrink-0 ${hint ? "text-accent" : ""}`}>{icon}</span>}
      {hint
        ? <span className="min-w-0"><span data-menu-text className="block truncate">{children}</span><span data-menu-text className="block truncate text-xs text-text-muted">{hint}</span></span>
        : <span data-menu-text className="min-w-0 truncate">{children}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-border" />;
}
