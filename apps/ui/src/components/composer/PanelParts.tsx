import { useEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { SearchIcon } from "./icons";
import { useComposition } from "../../hooks/useComposition";
import { draftDirection } from "../../lib/documentLanguage";

/**
 * The row of category icons over the emoji/GIF panel's grid; the chosen one is underlined. On a phone the row scrolls
 * sideways when its icons don't fit (composer.css): the underlined one, which follows the grid's scroll, is kept in view.
 */
export function CategoryBar({ label, items, active, onChoose, testIdPrefix }: {
  label: string;
  items: { id: string; label: string; icon: ReactNode }[];
  active: string | null;
  onChoose: (id: string) => void;
  testIdPrefix: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = row.current, icon = box?.querySelector<HTMLElement>("[data-active]");
    if (!box || !icon) return;
    const shown = box.getBoundingClientRect(), at = icon.getBoundingClientRect();
    if (at.left < shown.left) box.scrollLeft -= shown.left - at.left;
    else if (at.right > shown.right) box.scrollLeft += at.right - shown.right;
  }, [active]);
  return (
    <div ref={row} role="toolbar" aria-label={label} className="expression-categories">
      {items.map((item) => (
        <button key={item.id} type="button" data-testid={`${testIdPrefix}-${item.id}`} data-active={item.id === active || undefined}
          aria-label={item.label} title={item.label} aria-pressed={item.id === active} onClick={() => onChoose(item.id)}
          className="expression-category">
          {item.icon}
        </button>
      ))}
    </div>
  );
}

/** The panel's rounded search field. */
export function PanelSearch({ value, onChange, placeholder, inputRef, onKeyDown, after }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Something at the field's end, as the skin-tone button. */
  after?: ReactNode;
}) {
  const composition = useComposition();
  return (
    <div className="expression-search-row">
      <label className="expression-search">
        <SearchIcon />
        <input ref={inputRef} type="search" value={value} dir={draftDirection(value)} data-testid="expression-search" placeholder={placeholder} aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)} {...composition.inputProps}
          onKeyDown={(e) => { if (!composition.composing(e)) onKeyDown?.(e); }} autoComplete="off" spellCheck={false} />
      </label>
      {after}
    </div>
  );
}
