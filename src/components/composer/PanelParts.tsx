import type { KeyboardEvent, ReactNode, Ref } from "react";
import { SearchIcon } from "./icons";

/** The row of category icons over the emoji/GIF panel's grid; the chosen one is underlined. */
export function CategoryBar({ label, items, active, onChoose, testIdPrefix }: {
  label: string;
  items: { id: string; label: string; icon: ReactNode }[];
  active: string | null;
  onChoose: (id: string) => void;
  testIdPrefix: string;
}) {
  return (
    <div role="toolbar" aria-label={label} className="expression-categories">
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
  return (
    <div className="expression-search-row">
      <label className="expression-search">
        <SearchIcon />
        <input ref={inputRef} type="search" value={value} data-testid="expression-search" placeholder={placeholder} aria-label={placeholder}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} autoComplete="off" spellCheck={false} />
      </label>
      {after}
    </div>
  );
}
