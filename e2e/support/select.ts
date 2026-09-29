import { expect, type Locator } from "@playwright/test";

/**
 * The app's selects are `Select` (src/components/ui/Select.tsx), a combobox with a list of options, not a native
 * `<select>`: `locator.selectOption()` and `toHaveValue()` do not apply. Its value is in `data-value`, and its
 * options exist only while it is open.
 */

/** The options of a select, opening it first. `close(select)` puts it away again. */
export async function optionsOf(select: Locator): Promise<Locator> {
  if ((await select.getAttribute("aria-expanded")) !== "true") await select.click();
  await expect(select).toHaveAttribute("aria-controls", /.+/);
  const list = await select.getAttribute("aria-controls");
  return select.page().locator(`[id="${list}"] [role="option"]`);
}

/** Closes an open select without choosing. */
export async function close(select: Locator): Promise<void> {
  await select.press("Escape");
  await expect(select).toHaveAttribute("aria-expanded", "false");
}

/** Chooses the option with this value, as a person does: opens the select and clicks it. */
export async function choose(select: Locator, value: string): Promise<void> {
  const options = await optionsOf(select);
  await options.and(select.page().locator(`[data-value="${value}"]`)).click();
  await expect(select).toHaveAttribute("data-value", value);
}
