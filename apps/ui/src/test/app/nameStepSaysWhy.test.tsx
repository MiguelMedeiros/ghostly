import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NameStep } from "../../components/NameStep";
import { compose } from "../ime";
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
/** The step's polite status, as a screen reader has it now. */
const status = () => screen.getByTestId("name-step-full").textContent?.trim() ?? "";

/** Each text written into a polite status from now on: what a screen reader says, in order. */
function watchSaid() {
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
  return { said, stop: () => watch.disconnect() };
}

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
    const { said, stop } = watchSaid();
    await user.type(input, "a".repeat(25));
    await settle();
    expect(input.value).toBe("a".repeat(20));
    expect(said.filter((text) => text === words.full)).toEqual([words.full]);
    const region = screen.getByText(words.full).closest("[role=status]");
    expect(region, "a status, said politely, not an alert").not.toBeNull();

    await user.keyboard("{Backspace}");
    await settle();
    expect(region!.textContent?.trim()).toBe("");
    stop();
  });

  it("15 letters, then a paste of 10: the 5 that fit go in, and the cut is said once", async () => {
    const { user, input } = await open(language);
    await user.type(input, "a".repeat(15));
    const { said, stop } = watchSaid();
    await user.paste("b".repeat(10));
    await settle();
    expect(input.value).toBe("a".repeat(15) + "b".repeat(5));
    expect(said).toEqual([words.full]);
    expect(status()).toBe(words.full);
    stop();
  });

  it("a name of emoji, all selected, then a paste of 25 letters: 20 go in, and the cut is said though the name is shorter in UTF-16", async () => {
    const { user, input } = await open(language);
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    await user.paste(family.repeat(4));
    expect(input.value).toBe(family.repeat(4));
    expect(status()).toBe("");
    input.setSelectionRange(0, input.value.length);
    await user.paste("b".repeat(25));
    await settle();
    expect(input.value).toBe("b".repeat(20));
    expect(status()).toBe(words.full);
  });

  it("a word composed past the limit is left out whole, and the cut is said though the name has room for a letter", async () => {
    const { user, input } = await open(language);
    await user.type(input, "a".repeat(18));
    act(() => compose(input, ["\u306B\u307B\u3093\u3054", "\u65E5\u672C\u8A9E"]));
    await settle();
    expect(input.value).toBe("a".repeat(18));
    expect(status()).toBe(words.full);
  });

  it("at the limit, a character replaced keeps the cut said; only a delete that makes room clears it", async () => {
    const { user, input } = await open(language);
    const smile = "\u{1F600}";
    await user.paste(smile.repeat(20));
    await user.type(input, "x");
    await settle();
    expect(input.value).toBe(smile.repeat(20));
    expect(status()).toBe(words.full);
    // The last emoji (two UTF-16 units) replaced by one letter: still 20 characters, no room made.
    await user.type(input, "b", { initialSelectionStart: 38, initialSelectionEnd: 40 });
    await settle();
    expect(input.value).toBe(smile.repeat(19) + "b");
    expect(status()).toBe(words.full);
    await user.keyboard("{Backspace}");
    await settle();
    expect(input.value).toBe(smile.repeat(19));
    expect(status()).toBe("");
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
