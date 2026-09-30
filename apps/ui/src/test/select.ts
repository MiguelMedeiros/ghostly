import { within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * Driving a `Select` (components/ui/Select.tsx) as a person does. Its options exist only while it is open, so
 * these open it first; `user.selectOptions` is for native selects and does not apply.
 */

/** The list an open Select shows. */
export function listOf(select: HTMLElement): HTMLElement {
  const id = select.getAttribute("aria-controls");
  const list = id ? document.getElementById(id) : null;
  if (!list) throw new Error("The select is not open");
  return list;
}

export interface ShownOption { value: string; label: string; description?: string; disabled: boolean; selected: boolean }

/** What an option shows: its name (first line) and description (second line). */
export function readOption(option: HTMLElement): ShownOption {
  const text = (id: string | null) => (id ? document.getElementById(id)?.textContent ?? undefined : undefined);
  return {
    value: option.dataset.value ?? "",
    label: text(option.getAttribute("aria-labelledby")) ?? "",
    description: text(option.getAttribute("aria-describedby")),
    disabled: option.getAttribute("aria-disabled") === "true",
    selected: option.getAttribute("aria-selected") === "true",
  };
}

/** Opens the select and reads its options, then closes it again with Escape. */
export async function optionsOf(user: UserEvent, select: HTMLElement): Promise<ShownOption[]> {
  await user.click(select);
  const shown = within(listOf(select)).getAllByRole("option").map(readOption);
  await user.keyboard("{Escape}");
  return shown;
}

/** Opens the select and clicks the option with this value. */
export async function choose(user: UserEvent, select: HTMLElement, value: string): Promise<void> {
  if (select.getAttribute("aria-expanded") !== "true") await user.click(select);
  const option = within(listOf(select)).getAllByRole("option").find((o) => o.dataset.value === value);
  if (!option) throw new Error(`The select has no option ${value}`);
  await user.click(option);
}
