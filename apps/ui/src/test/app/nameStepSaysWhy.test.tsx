import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NameStep } from "../../components/NameStep";
import { NAME_STEP_TEST_KEY, askNameIn, setNameStepUnderTest } from "../../lib/nameStep";
import { setRunningProfile } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: profiles.name-step

/*
 * "What should people call you?" says what a name may be: the field is described by its limit, a
 * keystroke past it is said once in a polite status (not once per key), and Continue, off while the name is blank or
 * only invisible characters, is described by why.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const WORDS = {
  en: { limit: "Up to 20 letters.", full: "That's the most: 20 letters.", needName: "Type a name to continue." },
  ar: { limit: "حتى 20 حرفًا.", full: "هذا هو الحد الأقصى: 20 حرفًا.", needName: "اكتب اسمًا للمتابعة." },
} as const;

/** What a screen reader reads after an element's name: the text of each element its aria-describedby names. */
const description = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
  .map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ");
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

async function open(language: "en" | "ar") {
  askNameIn("");
  const rendered = renderApp(<NameStep />, { language });
  await settle();
  const input = await screen.findByTestId("name-step-input") as HTMLInputElement;
  return { ...rendered, input, save: screen.getByTestId("name-step-save") as HTMLButtonElement };
}

beforeEach(() => {
  localStorage.clear();
  setRunningProfile(undefined);
  setNameStepUnderTest(() => false);
  localStorage.setItem(NAME_STEP_TEST_KEY, "on");
});
afterEach(() => { setRunningProfile(undefined); });

describe.each(["en", "ar"] as const)("the name step in %s says what a name may be", (language) => {
  const words = WORDS[language];

  it("the field is described by its limit, shown under it", async () => {
    const { input } = await open(language);
    expect(description(input)).toContain(words.limit);
    expect(screen.getByText(words.limit)).toBeVisible();
  });

  it("25 letters typed: 20 kept, and the cut said once in a polite status, not once per key; a delete clears it", async () => {
    const { user, input } = await open(language);
    const said: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const region = target?.closest("[role=status], [aria-live=polite]");
        const text = region?.textContent?.trim();
        if (text) said.push(text);
      }
    });
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    await user.type(input, "a".repeat(25));
    await settle();
    expect(input.value).toBe("a".repeat(20));
    expect(said.filter((text) => text === words.full)).toEqual([words.full]);
    const region = screen.getByText(words.full).closest("[role=status]");
    expect(region, "a status, said politely, not an alert").not.toBeNull();

    await user.keyboard("{Backspace}");
    await settle();
    expect(region!.textContent?.trim()).toBe("");
    watch.disconnect();
  });

  it("Continue, off for a blank or invisible-only name, says why; a real name takes the reason away", async () => {
    const { user, input, save } = await open(language);
    expect(save.disabled).toBe(true);
    expect(description(save), "empty").toBe(words.needName);

    await user.type(input, "   ");
    expect(save.disabled).toBe(true);
    expect(description(save), "spaces only").toBe(words.needName);

    await user.clear(input);
    await user.type(input, "\u200b\u2066\u3164");
    expect(input.value.length).toBe(3);
    expect(save.disabled).toBe(true);
    expect(description(save), "invisible only").toBe(words.needName);
    expect(screen.getByText(words.needName)).toBeVisible();

    await user.clear(input);
    await user.type(input, "Casper");
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(description(save)).toBe("");
    expect(screen.queryByText(words.needName)).toBeNull();
  });
});
