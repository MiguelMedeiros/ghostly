import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { sanitizeNick } from "@ghostly/core";
import { NameStep } from "../../components/NameStep";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { NAME_STEP_TEST_KEY, askNameIn, setNameStepUnderTest } from "../../lib/nameStep";
import { cleanOwnName } from "../../lib/ownName";
import { loadSettings } from "../../lib/settings";
import { activeProfileId, setRunningProfile, settingsKeyFor } from "../../lib/profiles";
import { Profile } from "../../pages/Profile";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";

// covers: profiles.name-step

/*
 * The person's own name in chats is cleaned as a contact cleans it (`sanitizeNick`), in the name step, Profile and
 * Settings alike: hidden characters gone, spaces collapsed and trimmed, a name with nothing visible is no name, and
 * the 20 characters are counted as seen, never cut inside an emoji.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const stored = () => (JSON.parse(localStorage.getItem(settingsKeyFor(activeProfileId())) ?? "{}") as { defaultNickname?: string }).defaultNickname ?? "";
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const ZWSP = "​";
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";

beforeEach(() => {
  localStorage.clear();
  setRunningProfile(undefined);
  setNameStepUnderTest(() => false);
});

describe("the name step", () => {
  beforeEach(() => { localStorage.setItem(NAME_STEP_TEST_KEY, "on"); askNameIn(""); });

  it("a name of zero-width spaces is no name: Continue stays off and nothing is saved", async () => {
    const { user } = renderApp(<NameStep />);
    await settle();
    const input = await screen.findByTestId("name-step-input");
    await user.type(input, `${ZWSP}${ZWSP}${ZWSP}`);
    expect((input as HTMLInputElement).value).toBe(`${ZWSP}${ZWSP}${ZWSP}`);
    expect((screen.getByTestId("name-step-save") as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("name-step")).toBeInTheDocument();
    expect(stored()).toBe("");
  });

  it("keeps two emoji families whole: the 20 are counted as characters seen, not UTF-16 units", async () => {
    const { user } = renderApp(<NameStep />);
    await settle();
    const input = await screen.findByTestId("name-step-input");
    input.focus();
    await user.paste(`${FAMILY}${FAMILY}`);
    expect((input as HTMLInputElement).value).toBe(`${FAMILY}${FAMILY}`);
    await user.click(screen.getByTestId("name-step-save"));
    await waitFor(() => expect(stored()).toBe(`${FAMILY}${FAMILY}`));
  });

  it("saves the name without its hidden characters", async () => {
    const { user } = renderApp(<NameStep />);
    await settle();
    const input = await screen.findByTestId("name-step-input");
    input.focus();
    await user.paste(` A‮na${ZWSP}  `);
    await user.click(screen.getByTestId("name-step-save"));
    await waitFor(() => expect(stored()).toBe("Ana"));
  });
});

describe("Name in chats", () => {
  for (const [page, testId, render] of [["Profile", "account-nickname", () => <Profile />], ["Settings", null, () => <LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>]] as const) {
    it(`${page}: saves the name trimmed while it is typed, shows it so on blur, and spaces alone are no name`, async () => {
      const { user } = renderApp(render());
      const input = testId ? screen.getByTestId(testId) as HTMLInputElement : document.getElementById("settings-nickname") as HTMLInputElement;
      await user.type(input, "  Bob  Lee ");
      expect(input.value, "a space typed between words stays").toBe("  Bob  Lee ");
      await waitFor(() => expect(stored()).toBe("Bob Lee"));
      await user.tab();
      expect(input.value).toBe("Bob Lee");

      await user.clear(input);
      await user.type(input, `   ${ZWSP}`);
      await waitFor(() => expect(stored()).toBe(""));
      await user.tab();
      expect(input.value).toBe("");
    });
  }

  it("counts 20 characters as seen: 20 emoji fit, the 21st does not", async () => {
    const { user } = renderApp(<Profile />);
    const input = screen.getByTestId("account-nickname") as HTMLInputElement;
    input.focus();
    await user.paste("👻".repeat(25));
    expect(input.value).toBe("👻".repeat(20));
    await waitFor(() => expect(stored()).toBe("👻".repeat(20)));
  });
});

describe("a name saved before", () => {
  it("of spaces or zero-width characters reads as no name; one with edge spaces reads trimmed", () => {
    localStorage.setItem(settingsKeyFor(""), JSON.stringify({ defaultNickname: `${ZWSP}${ZWSP}` }));
    expect(loadSettings().defaultNickname).toBe("");
    localStorage.setItem(settingsKeyFor(""), JSON.stringify({ defaultNickname: "  Bob  " }));
    expect(loadSettings().defaultNickname).toBe("Bob");
  });

  it("reads here as a contact reads it", () => {
    for (const name of ["  Bob  ", `${ZWSP}x${ZWSP}`, "a‮b", `${FAMILY} ${FAMILY}`, "Ana\tMaria"]) {
      expect(cleanOwnName(name), JSON.stringify(name)).toBe(sanitizeNick(cleanOwnName(name)));
    }
  });
});
