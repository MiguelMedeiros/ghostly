import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useIsMobile } from "../hooks/useIsMobile";

/** Space kept between a menu and the edges of the window. */
const MARGIN = 8;

/**
 * A dropdown of actions. Every row is one line in every language: the menu is as wide as its longest row
 * (between a floor and the window), and only a row wider than that is cut, with the full text on hover.
 * On a wide screen it drops from its opener and moves over, or up, to stay in the window; on a phone it is a
 * sheet from the bottom with full-width rows. Outside clicks and Escape close it.
 */
export function Menu({ open, onClose, anchorRef, testId, id, children }: {
  open: boolean;
  onClose: () => void;
  /** The opener and its positioned wrapper: the menu drops from its end edge, and clicks on it are not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  testId: string;
  id?: string;
  children: ReactNode;
}) {
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  useOutsideDismiss(ref, open, onClose, anchorRef);
  const [place, setPlace] = useState<{ shift: number; up: boolean }>({ shift: 0, up: false });

  useLayoutEffect(() => {
    if (!open || phone) return;
    const fit = () => {
      const menu = ref.current, anchor = anchorRef.current;
      if (!menu || !anchor) return;
      // Measured where it would open without any correction.
      const before = menu.style.translate;
      menu.style.translate = "0";
      const rect = menu.getBoundingClientRect(), opener = anchor.getBoundingClientRect();
      const width = document.documentElement.clientWidth, height = window.innerHeight;
      const shift = rect.left < MARGIN ? MARGIN - rect.left : rect.right > width - MARGIN ? Math.max(MARGIN - rect.left, width - MARGIN - rect.right) : 0;
      const up = opener.bottom + rect.height + MARGIN > height && opener.top - rect.height - MARGIN > 0;
      menu.style.translate = before;
      setPlace(was => was.shift === shift && was.up === up ? was : { shift, up });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, phone, anchorRef]);

  if (!open) return null;

  if (phone) return createPortal(<>
    <div aria-hidden="true" className="fixed inset-0 z-50 bg-black/40 animate-fade-in" />
    <div ref={ref} id={id} data-testid={testId} data-menu="sheet"
      className="menu-sheet fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface-alt px-1 pt-2 pb-safe shadow-2xl animate-fade-in">
      <div aria-hidden="true" className="mx-auto mb-2 h-1 w-9 rounded-full bg-border-bright" />
      {children}
    </div>
  </>, document.body);

  return (
    <div ref={ref} id={id} data-testid={testId} data-menu="popover"
      style={{ translate: place.shift ? `${place.shift}px 0` : undefined } as CSSProperties}
      className={`absolute end-0 z-50 w-max min-w-44 max-w-[min(20rem,calc(100vw-1rem))] rounded-lg border border-border bg-surface-alt py-1 shadow-lg animate-fade-in ${place.up ? "bottom-full mb-1" : "top-full mt-1"}`}>
      {children}
    </div>
  );
}

/** Shows the whole text on hover only when the row had to cut it. */
function titleIfCut(row: HTMLElement) {
  const cut = [...row.querySelectorAll<HTMLElement>("[data-menu-text]")].some(el => el.scrollWidth > el.clientWidth);
  if (cut) row.title = row.innerText.replace(/\s+/g, " ").trim();
  else row.removeAttribute("title");
}

export function MenuItem({ icon, children, hint, onClick, danger, testId }: {
  icon?: ReactNode;
  children: ReactNode;
  /** A second, quieter line under the label; one line too. */
  hint?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <button type="button" data-testid={testId} data-menu-item onClick={onClick}
      onPointerEnter={e => titleIfCut(e.currentTarget)} onFocus={e => titleIfCut(e.currentTarget)}
      className={`flex w-full min-w-0 items-center whitespace-nowrap px-3 py-2 text-start text-sm transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none max-md:min-h-12 max-md:rounded-lg ${hint ? "gap-3" : "gap-2"} ${danger ? "text-danger" : hint ? "text-text-primary" : "text-text-secondary hover:text-text-primary"}`}>
      {icon && <span aria-hidden="true" className={`flex shrink-0 ${hint ? "text-accent" : ""}`}>{icon}</span>}
      {hint
        ? <span className="min-w-0"><span data-menu-text className="block truncate">{children}</span><span data-menu-text className="block truncate text-xs text-text-muted">{hint}</span></span>
        : <span data-menu-text className="min-w-0 truncate">{children}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-border" />;
}
