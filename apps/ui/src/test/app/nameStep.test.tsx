import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceInvite } from "@ghostly/core";
import { NameStep } from "../../components/NameStep";
import { offerDeviceLink, takeDeviceLink } from "../../lib/devices";
import { NAME_STEP_TEST_KEY, askNameIn, nameStepAllowed, nameStepPending, setNameStepUnderTest } from "../../lib/nameStep";
import { loadSettings } from "../../lib/settings";
import { activeProfileId, createProfile, newProfileId, prefixOf, registerProfile, setRunningProfile, settingsKeyFor } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: profiles.name-step

/*
 * A new profile asks once "What should people call you?" (lib/nameStep.ts, components/NameStep.tsx): the field empty,
 * a placeholder in it, and Skip, which keeps the anonymous label contacts see today. A profile restored from a backup,
 * one this page opened to add to a profile on another device, and one with a name already are never asked; nor is
 * an automated browser, unless the test switch asks for it.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const nickname = () => (JSON.parse(localStorage.getItem(settingsKeyFor(activeProfileId())) ?? "{}") as { defaultNickname?: string }).defaultNickname ?? "";
/** Lets the effect's check (a promise) answer. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  localStorage.clear();
  setRunningProfile(undefined);
  setNameStepUnderTest(() => false);
});
afterEach(() => {
  setRunningProfile(undefined);
  vi.restoreAllMocks();
});

describe("which profile is new", () => {
  it("the first start, whose settings are read for the first time, is asked", () => {
    loadSettings();
    expect(nameStepPending()).toBe(true);
  });

  it("a profile with settings already, or a chat, is not: it is in use", () => {
    localStorage.setItem(settingsKeyFor(""), JSON.stringify({ language: "en" }));
    loadSettings();
    expect(nameStepPending()).toBe(false);
    localStorage.clear();
    localStorage.setItem(`${prefixOf("")}chat1`, JSON.stringify({ id: "chat1", mySeedB64: "s", peerPubKeyB64: "p", encKeyB64: "e", createdAt: 0, messages: [] }));
    loadSettings();
    expect(nameStepPending()).toBe(false);
  });

  it("a profile made with New profile is asked; one made to add this device to a profile is not", () => {
    localStorage.setItem(settingsKeyFor(""), JSON.stringify({ language: "en" }));
    const made = createProfile("Work");
    askNameIn(made.id);
    expect(nameStepPending(made.id)).toBe(true);
    const joining = createProfile("Joined");
    expect(nameStepPending(joining.id), "createProfile alone never asks (joinInNewProfile)").toBe(false);
  });
});

describe("the switch", () => {
  it("is off in an automated browser and in a test build, on for a person's app; the storage switch wins", async () => {
    vi.spyOn(navigator, "webdriver", "get").mockReturnValue(true);
    expect(await nameStepAllowed()).toBe(false);
    localStorage.setItem(NAME_STEP_TEST_KEY, "on");
    expect(await nameStepAllowed()).toBe(true);
    localStorage.removeItem(NAME_STEP_TEST_KEY);
    vi.spyOn(navigator, "webdriver", "get").mockReturnValue(false);
    expect(await nameStepAllowed()).toBe(true);
    setNameStepUnderTest(async () => true);
    expect(await nameStepAllowed()).toBe(false);
    localStorage.setItem(NAME_STEP_TEST_KEY, "off");
    setNameStepUnderTest(() => false);
    expect(await nameStepAllowed()).toBe(false);
  });
});

describe("What should people call you?", () => {
  beforeEach(() => { localStorage.setItem(NAME_STEP_TEST_KEY, "on"); });

  it("asks a new profile with the field empty, and keeps the name it is given", async () => {
    askNameIn("");
    const { user } = renderApp(<NameStep />);
    await settle();
    const input = await screen.findByTestId("name-step-input");
    expect(screen.getByRole("heading", { name: "What should people call you?" })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("Your name");
    expect((screen.getByTestId("name-step-save") as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, "  Casper  ");
    await user.click(screen.getByTestId("name-step-save"));
    await waitFor(() => expect(screen.queryByTestId("name-step")).toBeNull());
    await waitFor(() => expect(nickname()).toBe("Casper"));
    expect(nameStepPending(), "asked once").toBe(false);
  });

  it("Skip keeps today's default: no name, and it is not asked again", async () => {
    askNameIn("");
    const { user, unmount } = renderApp(<NameStep />);
    await settle();
    await user.click(await screen.findByTestId("name-step-skip"));
    expect(screen.queryByTestId("name-step")).toBeNull();
    expect(nickname()).toBe("");
    expect(nameStepPending()).toBe(false);
    unmount();
    renderApp(<NameStep />);
    await settle();
    expect(screen.queryByTestId("name-step")).toBeNull();
  });

  it("Save, Skip or Escape leave the focus on New, not on the page's body", async () => {
    for (const close of ["save", "skip", "escape"] as const) {
      localStorage.clear();
      localStorage.setItem(NAME_STEP_TEST_KEY, "on");
      askNameIn("");
      const { user, unmount } = renderApp(<><button data-testid="sidebar-new-chat">New</button><NameStep /></>);
      await settle();
      const input = await screen.findByTestId("name-step-input");
      input.focus();
      if (close === "save") { await user.type(input, "Boo"); await user.keyboard("{Enter}"); }
      else if (close === "skip") await user.click(screen.getByTestId("name-step-skip"));
      else screen.getByTestId("name-step").dispatchEvent(new Event("cancel", { cancelable: true }));
      await waitFor(() => expect(screen.queryByTestId("name-step")).toBeNull());
      await waitFor(() => expect(document.activeElement, close).toBe(screen.getByTestId("sidebar-new-chat")));
      unmount();
    }
  });

  // A narrow window that opened an invite link: the chat fills the screen, the list (and New in it) is mounted but hidden.
  it("over a chat, the focus goes to its message field, or to its back button on a touch screen; never to a hidden New", async () => {
    const coarse = (touch: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
      ({ matches: touch ? query.includes("coarse") : query.includes("fine"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    for (const [touch, close, expected] of [[false, "save", "composer"], [false, "skip", "composer"], [true, "save", "chat-back"], [true, "skip", "chat-back"]] as const) {
      localStorage.clear();
      localStorage.setItem(NAME_STEP_TEST_KEY, "on");
      askNameIn("");
      coarse(touch);
      const { user, unmount } = renderApp(<>
        <div hidden><button data-testid="sidebar-new-chat">New</button></div>
        <button data-testid="chat-back">Back</button>
        <textarea data-testid="composer" className="composer-textarea" />
        <NameStep />
      </>);
      await settle();
      const input = await screen.findByTestId("name-step-input");
      input.focus();
      if (close === "save") { await user.type(input, "Boo"); await user.keyboard("{Enter}"); }
      else await user.click(screen.getByTestId("name-step-skip"));
      await waitFor(() => expect(screen.queryByTestId("name-step")).toBeNull());
      await waitFor(() => expect(document.activeElement, `${touch ? "touch" : "mouse"} ${close}`).toBe(screen.getByTestId(expected)));
      unmount();
      vi.restoreAllMocks();
    }
  });

  // A link another tab forwards (`takeLinks`), or the installed app's launch with one, puts it in this page's address: a
  // popstate onto an entry with no layer on it. That is no answer: the step stays over the chat it opened, name and all.
  it("a link that reaches the page while it asks leaves it open, with the name typed; Back still closes it", async () => {
    history.replaceState(null, "", "#/");
    askNameIn("");
    const { user } = renderApp(<NameStep />);
    await settle();
    const input = await screen.findByTestId("name-step-input");
    await user.type(input, "Casper");
    await waitFor(() => expect(typeof (history.state as Record<string, unknown> | null)?.ghostlyLayer).toBe("number"));

    // `location.hash = link` as a browser does it (happy-dom fires no popstate for it): a new entry, then a popstate.
    await act(async () => {
      history.pushState(null, "", "#ghostly1link");
      dispatchEvent(new PopStateEvent("popstate", { state: null }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId("name-step")).toBeTruthy();
    expect((screen.getByTestId("name-step-input") as HTMLInputElement).value).toBe("Casper");
    expect(nameStepPending(), "still asked").toBe(true);
    await waitFor(() => expect(typeof (history.state as Record<string, unknown> | null)?.ghostlyLayer, "Back has an entry to close it again").toBe("number"));

    await act(async () => { history.back(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    await waitFor(() => expect(screen.queryByTestId("name-step")).toBeNull());
    expect(location.hash).toBe("#ghostly1link");
    expect(nameStepPending()).toBe(false);
  });

  it("is never asked without the mark", async () => {
    // A profile that has run before: its settings are saved.
    localStorage.setItem(settingsKeyFor(""), JSON.stringify({ language: "en" }));
    renderApp(<NameStep />);
    await settle();
    expect(screen.queryByTestId("name-step")).toBeNull();
  });

  it("a profile with a name already is not asked", async () => {
    askNameIn("");
    localStorage.setItem(settingsKeyFor(""), JSON.stringify({ defaultNickname: "Boo" }));
    renderApp(<NameStep />);
    await settle();
    expect(screen.queryByTestId("name-step")).toBeNull();
  });

  it("a restored profile is not asked", async () => {
    const entry = registerProfile(newProfileId(), "Work", true);
    setRunningProfile(entry.id);
    askNameIn(entry.id);
    renderApp(<NameStep />);
    await settle();
    expect(screen.queryByTestId("name-step")).toBeNull();
  });

  it("an automated browser is not asked, unless the test switch says so", async () => {
    localStorage.removeItem(NAME_STEP_TEST_KEY);
    vi.spyOn(navigator, "webdriver", "get").mockReturnValue(true);
    askNameIn("");
    renderApp(<NameStep />);
    await settle();
    expect(screen.queryByTestId("name-step")).toBeNull();
    expect(nameStepPending(), "still asked in a person's app").toBe(true);
  });

  // Last: the page remembers it was handed a device code.
  it("a page opened with a device code, to add this device to a profile, is not asked", async () => {
    askNameIn("");
    offerDeviceLink(createDeviceInvite(new Uint8Array(32).fill(7)).code);
    takeDeviceLink();
    renderApp(<NameStep />);
    await settle();
    expect(screen.queryByTestId("name-step")).toBeNull();
  });
});
