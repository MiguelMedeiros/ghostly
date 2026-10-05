import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceInvite } from "@ghostly/core";
import { NameStep } from "../../components/NameStep";
import { offerDeviceLink, takeDeviceLink } from "../../lib/devices";
import { NAME_STEP_TEST_KEY, askNameIn, markFirstStart, nameStepAllowed, nameStepPending, setNameStepUnderTest } from "../../lib/nameStep";
import { activeProfileId, newProfileId, prefixOf, registerProfile, setRunningProfile, settingsKeyFor } from "../../lib/profiles";
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
  it("the first start, with no settings saved and no chat, is asked", () => {
    markFirstStart();
    expect(nameStepPending()).toBe(true);
  });

  it("a profile with settings already, or a chat, is not: it is in use", () => {
    localStorage.setItem(settingsKeyFor(""), JSON.stringify({ language: "en" }));
    markFirstStart();
    expect(nameStepPending()).toBe(false);
    localStorage.clear();
    localStorage.setItem(`${prefixOf("")}chat1`, JSON.stringify({ id: "chat1", mySeedB64: "s", peerPubKeyB64: "p", encKeyB64: "e", createdAt: 0, messages: [] }));
    markFirstStart();
    expect(nameStepPending()).toBe(false);
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

  it("is never asked without the mark", async () => {
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
