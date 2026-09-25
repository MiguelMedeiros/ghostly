import { useRef, type ReactNode, type RefObject } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { Menu, MenuItem } from "../Menu";
import { PlusIcon } from "./icons";

export interface ComposerAction {
  /** Also the colour of its icon (composer.css `--attach-<id>`). */
  id: "payment" | "identity" | "document" | "media" | "camera";
  label: string;
  icon: ReactNode;
  testId: string;
  onSelect: () => void;
  /** Why it cannot be used in this chat now: the row stays, greyed, saying so. */
  unavailable?: string;
  /** A quieter second line while it can be used. */
  hint?: string;
  data?: Record<`data-${string}`, string | number | undefined>;
}

/**
 * The composer's +: what can go into a chat besides text, one coloured row each, as in WhatsApp. A popover over
 * the + on a wide screen, a sheet on a phone (Menu). The first row takes the focus, the arrows move, Enter
 * chooses, and Escape gives the focus back to the +.
 */
export function ComposerMenu({ actions, open, onOpenChange, disabled, buttonRef }: {
  actions: ComposerAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  /** The + itself, where what a row opens gives the focus back. */
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLDivElement>(null);
  const own = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? own;
  const close = () => {
    onOpenChange(false);
    // Escape, or a tap on a phone's backdrop, leaves the focus nowhere: back to the +. A click that moved it elsewhere keeps it there.
    const at = document.activeElement;
    if (!at || at === document.body || at.closest("[data-testid='composer-menu']")) button.current?.focus({ preventScroll: true });
  };
  return (
    <div ref={anchor} className="relative flex shrink-0">
      <button ref={button} type="button" onClick={() => onOpenChange(!open)} disabled={disabled || !actions.length}
        data-testid="composer-more" aria-label={t("composer.attach")} title={t("composer.attach")} aria-expanded={open} aria-haspopup="true"
        aria-controls={open ? "composer-menu" : undefined}
        className={`composer-icon-button ${open ? "composer-plus-open" : ""}`}>
        <PlusIcon />
      </button>
      <Menu open={open} onClose={close} anchorRef={anchor} testId="composer-menu" id="composer-menu" label={t("composer.attach")}
        align="start" prefer="up" focusFirst className="composer-menu">
        {actions.map((action) => (
          <MenuItem key={action.id} testId={action.testId} icon={<span className="composer-menu-icon" data-action={action.id}>{action.icon}</span>}
            disabled={!!action.unavailable} title={action.unavailable ?? action.hint} hint={action.unavailable ?? action.hint}
            data={{ "data-action": action.id, ...action.data }}
            onClick={() => { onOpenChange(false); action.onSelect(); }}>
            {action.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}
