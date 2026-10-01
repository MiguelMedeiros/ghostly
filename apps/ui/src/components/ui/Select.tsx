import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface SelectOption<V extends string = string> {
  value: V;
  /** The option's name: what the closed select shows and what typing a letter matches. */
  label: string;
  /** A second, dimmer line: the host beside a resolver's name, the balance beside a mint. */
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  /** The chosen value; one that matches no option (e.g. "") shows `placeholder`. */
  value: V | "";
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  /** For a `<label htmlFor>`. */
  id?: string;
  /** Submits the value with a form, through a hidden input. */
  name?: string;
  disabled?: boolean;
  /** `sm` for tight places (a chat bubble). */
  size?: "md" | "sm";
  /** As wide as its value (up to the line) instead of the whole line: for a `Row`'s control. */
  fit?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
}

// The list goes to the top layer where the popover API exists (above dialogs, out of any overflow or transform);
// elsewhere it is a fixed element on top of the page.
const TOP_LAYER = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
const MAX_HEIGHT = 320;
const MIN_WIDTH = 224;
const EDGE = 8;
const TYPEAHEAD_MS = 500;

type Place = { left: number; width: number; maxHeight: number } & ({ top: number } | { bottom: number });

/**
 * A select in the app's look: a field-like button and a list like the app's menus, with a second line and an
 * icon per option. It is the WAI-ARIA "select-only combobox": focus stays on the button, the list follows it
 * with `aria-activedescendant`, and the keys are a native select's (arrows, Home/End, PageUp/PageDown, letters,
 * Enter/Space to choose, Escape to close without choosing, Tab to choose and move on).
 */
export function Select<V extends string = string>({
  value, options, onChange, placeholder = "", id, name, disabled = false, size = "md", fit = false,
  "aria-label": ariaLabel, "aria-labelledby": labelledBy, "aria-describedby": describedBy, "data-testid": testId,
}: SelectProps<V>) {
  const uid = useId();
  const triggerId = id ?? `${uid}select`;
  const listId = `${uid}list`;
  const optionId = (i: number) => `${uid}option-${i}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<Place | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const selected = options.findIndex(o => o.value === value);
  const current = options[selected];
  const usable = (i: number) => i >= 0 && i < options.length && !options[i].disabled;
  /** The next usable option from `from` going `by` (±1, ±10), stopping at the ends; `from` when there is none. */
  const move = (from: number, by: number) => {
    const dir = Math.sign(by);
    let found = from;
    for (let i = from + dir, left = Math.abs(by); i >= 0 && i < options.length && left > 0; i += dir) if (usable(i)) { found = i; left--; }
    return found;
  };
  const first = () => move(-1, 1);
  const last = () => move(options.length, -1);
  const start = () => (selected >= 0 ? selected : first());

  const show = (at: number) => {
    if (disabled || !options.length) return;
    setHost(trigger.current?.closest("dialog") ?? document.body);
    setPlace(null);
    setActive(at);
    setOpen(true);
  };
  const choose = (i: number, refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
    if (usable(i) && options[i].value !== value) onChange(options[i].value);
  };

  /** Typing a name: letters within half a second add up; the same letter again goes to the next option with it. */
  const find = (key: string, from: number) => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > TYPEAHEAD_MS ? key.toLowerCase() : t.text + key.toLowerCase();
    t.at = now;
    const repeated = [...t.text].every(c => c === t.text[0]);
    const needle = repeated ? t.text[0] : t.text;
    const begin = repeated || from < 0 ? from + 1 : from;
    for (let k = 0; k < options.length; k++) {
      const i = (begin + k) % options.length;
      if (usable(i) && options[i].label.toLowerCase().startsWith(needle)) return i;
    }
    return -1;
  };
  const typing = () => !!typed.current.text && Date.now() - typed.current.at <= TYPEAHEAD_MS;
  const printable = (e: KeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { handled(); show(start()); }
      else if (e.key === "Home") { handled(); show(first()); }
      else if (e.key === "End") { handled(); show(last()); }
      else if (printable(e)) { handled(); const i = find(e.key, selected); show(i >= 0 ? i : start()); }
      return;
    }
    switch (e.key) {
      case "ArrowDown": handled(); if (!e.altKey) setActive(move(active, 1)); break;
      case "ArrowUp": handled(); if (e.altKey) choose(active); else setActive(move(active, -1)); break;
      case "PageDown": handled(); setActive(move(active, 10)); break;
      case "PageUp": handled(); setActive(move(active, -10)); break;
      case "Home": handled(); setActive(first()); break;
      case "End": handled(); setActive(last()); break;
      case "Enter": handled(); choose(active); break;
      case "Escape": handled(); setOpen(false); break;
      // Tab chooses and lets focus move on, as the pattern says.
      case "Tab": choose(active, false); break;
      case " ": handled(); if (typing()) { const i = find(" ", active); if (i >= 0) setActive(i); } else choose(active); break;
      default: if (printable(e)) { handled(); const i = find(e.key, active); if (i >= 0) setActive(i); }
    }
  };

  // Where the list goes: under the button, or above it when there is more room there; never past the screen.
  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current;
    if (el && TOP_LAYER && !el.matches(":popover-open")) {
      try { el.showPopover(); } catch { /* not in the document yet, or unsupported: a fixed element still works */ }
    }
    const measure = () => {
      const button = trigger.current;
      if (!button || !list.current) return;
      const r = button.getBoundingClientRect();
      const vw = window.visualViewport?.width ?? window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const width = Math.min(Math.max(r.width, MIN_WIDTH), vw - 2 * EDGE);
      const rtl = getComputedStyle(button).direction === "rtl";
      const left = Math.min(Math.max(rtl ? r.right - width : r.left, EDGE), vw - EDGE - width);
      const below = vh - r.bottom - EDGE - 4;
      const above = r.top - EDGE - 4;
      const wanted = Math.min(list.current.scrollHeight, MAX_HEIGHT);
      setPlace(below >= wanted || below >= above
        ? { left, width, top: r.bottom + 4, maxHeight: Math.max(Math.min(MAX_HEIGHT, below), 0) }
        : { left, width, bottom: vh - r.top + 4, maxHeight: Math.min(MAX_HEIGHT, above) });
    };
    measure();
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    // Scrolling the page under an open list: it follows its button (a scroll inside the list does not move it).
    const scrolled = (e: Event) => { if (!list.current?.contains(e.target as Node)) later(); };
    window.addEventListener("resize", later);
    window.visualViewport?.addEventListener("resize", later);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", later);
      window.visualViewport?.removeEventListener("resize", later);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [open, host]);

  // A press anywhere else, or focus moving elsewhere, closes it without choosing.
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) => !trigger.current?.contains(target as Node) && !list.current?.contains(target as Node);
    const down = (e: PointerEvent) => { if (outside(e.target)) setOpen(false); };
    const focus = (e: FocusEvent) => { if (outside(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("focusin", focus, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("focusin", focus, true); };
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId is derived from uid, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, place]);

  const small = size === "sm";
  // Every side is set: a popover's own style (inset: 0) would fill in any side left out.
  const style: CSSProperties = { position: "fixed", margin: 0, top: "auto", right: "auto", bottom: "auto", ...(place ?? { top: 0, left: 0, visibility: "hidden" }) };
  const listLabel = labelledBy ? { "aria-labelledby": labelledBy } : ariaLabel ? { "aria-label": ariaLabel } : { "aria-labelledby": triggerId };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={triggerId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        title={current ? [current.label, current.description].filter(Boolean).join(" — ") : undefined}
        onClick={() => (open ? setOpen(false) : show(start()))}
        onKeyDown={onKeyDown}
        // Space would click the button again on release in some browsers, reopening what Space just closed.
        onKeyUp={e => { if (e.key === " ") e.preventDefault(); }}
        className={`${fit ? "inline-flex w-auto" : "flex w-full"} min-w-0 max-w-full items-center gap-2 rounded-lg border border-border bg-input-bg text-start text-text-primary transition-colors hover:border-border-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border ${open ? "border-border-bright" : ""} ${small ? "min-h-8 px-2 py-1 text-xs" : "min-h-10 px-3 py-2 text-sm max-md:min-h-11"}`}
      >
        {current?.icon && <span aria-hidden="true" className="flex shrink-0 items-center">{current.icon}</span>}
        <span className="min-w-0 flex-1 truncate">
          {current ? <>{current.label}{current.description && <> <span className="ms-1 text-xs text-text-muted">{current.description}</span></>}</> : <span className="text-text-muted">{placeholder}</span>}
        </span>
        <svg aria-hidden="true" width={small ? 12 : 14} height={small ? 12 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {name !== undefined && <input type="hidden" name={name} value={value} />}
      {open && host && createPortal(
        <div
          ref={list}
          id={listId}
          role="listbox"
          {...listLabel}
          {...(TOP_LAYER ? { popover: "manual" as const } : {})}
          data-testid={testId ? `${testId}-list` : undefined}
          data-placement={place && "bottom" in place ? "top" : "bottom"}
          style={style}
          // Keeps focus on the button (the list is never focused), and keeps a press here from reaching
          // whatever dismisses the dialog or popover the select sits in.
          onMouseDown={e => e.preventDefault()}
          onPointerDown={e => e.stopPropagation()}
          onPointerUp={e => e.stopPropagation()}
          className={`select-list z-[100] overflow-y-auto overscroll-contain rounded-xl border border-border-bright bg-panel-header p-1 text-text-primary shadow-2xl ${small ? "text-xs" : "text-sm"}`}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === selected}
              aria-disabled={o.disabled || undefined}
              // Named by its first line, described by its second: read as "Quad9, dns.quad9.net", not run together.
              aria-labelledby={`${optionId(i)}-label`}
              aria-describedby={o.description ? `${optionId(i)}-description` : undefined}
              data-value={o.value}
              data-active={i === active || undefined}
              onMouseMove={() => { if (usable(i) && i !== active) setActive(i); }}
              onClick={() => { if (usable(i)) choose(i); }}
              className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 data-[active]:bg-surface-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-40 max-md:min-h-11"
            >
              {o.icon && <span aria-hidden="true" className="flex shrink-0 items-center">{o.icon}</span>}
              <span className="min-w-0 flex-1">
                <span id={`${optionId(i)}-label`} className="block truncate">{o.label}</span>
                {o.description && <span id={`${optionId(i)}-description`} className="block truncate text-xs text-text-muted">{o.description}</span>}
              </span>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                className={`shrink-0 text-accent ${i === selected ? "" : "invisible"}`}><path d="M20 6 9 17l-5-5" /></svg>
            </div>
          ))}
        </div>,
        host,
      )}
    </>
  );
}
