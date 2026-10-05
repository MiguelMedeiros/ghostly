import type { ReactNode } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceInvite } from "@ghostly/core";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import { JoinDialog } from "../../components/JoinDialog";
import { ProfileSwitcherMenu } from "../../components/ProfileSwitcher";
import { Sidebar } from "../../components/Sidebar";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { JoinHost } from "../../components/devices/JoinHost";
import { Home } from "../../pages/Home";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Profile } from "../../pages/Profile";
import { deviceLink, deviceLinkQr, deviceNoun, offerDeviceLink, readDeviceLink, takeDeviceLink, takeDeviceLinkFromAddress, takeJoinRequest, timeLeft } from "../../lib/devices";
import { handOverUnlock, takeUnlockHandover } from "../../lib/lockHandover";
import { activeProfileId, createProfile, listProfiles, prefixOf } from "../../lib/profiles";
import { hashPassword } from "../../lib/settings";
import { listSessions } from "../../lib/storage";
import { appLinkOrigin } from "../../lib/url";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.enroll

/*
 * Adding this device to a profile it does not hold yet (WISP 06 § User experience). Every route to a device code ends on
 * one screen, "Add this phone to <profile>", in any profile: the camera opening the link, Join on the chat list, "I
 * already use Ghostly", "Add this device to another profile", a paste. That screen joins here in a fresh profile, and
 * makes a new profile for the code (which goes on to the digits by itself) in one that holds something, never putting
 * the code into a profile in use.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const Providers = ({ children }: { children: ReactNode }) => <LockScreenProvider><UpdateProvider>{children}</UpdateProvider></LockScreenProvider>;
const code = () => createDeviceInvite(new Uint8Array(32).fill(7)).code;
const JOIN_REQUEST = "ghostly_join_device";
const HANDOVER = "ghostly_unlock_handover";
const PIXEL = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const IN_USE = "enroll-in-use: This profile is in use here. Add a new profile first, and add the device from there.";

/** A chat in this profile: a device that is in use. */
function aChat() {
  localStorage.setItem(`${prefixOf(activeProfileId())}chat1`, JSON.stringify({ id: "chat1", mySeedB64: "s", peerPubKeyB64: "p", encKeyB64: "e", createdAt: 0, messages: [{ id: "m0" }] }));
}

/** The reload a profile switch ends with, caught: the test stays on this page. */
function catchReload() {
  const reload = vi.fn();
  const location = window.location;
  vi.spyOn(window, "location", "get").mockReturnValue(new Proxy(location, { get: (target, key) => (key === "reload" ? reload : Reflect.get(target, key)) }));
  return reload;
}

const phone = () => vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(max-width: 767px)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
const asPixel = () => Object.defineProperty(navigator, "userAgent", { configurable: true, value: PIXEL });

/** The one screen, once it shows. */
const oneScreen = () => screen.findByTestId("device-join-confirm");

beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  sessionStorage.clear();
  window.history.replaceState(null, "", "#/");
  takeDeviceLink();
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  Reflect.deleteProperty(navigator, "userAgent");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("I already use Ghostly", () => {
  it("on a phone the chat list of a fresh profile offers it, and the dialog opens over the list", async () => {
    phone();
    const { user } = renderApp(<Providers><Sidebar /><JoinHost /></Providers>);
    await user.click(await screen.findByTestId("sidebar-already"));
    expect(screen.getByTestId("device-join-add")).toHaveTextContent("Add this device to my profile");
  });

  it("on a wide screen the chat list leaves it to the home pane, which opens the same dialog", async () => {
    const { user } = renderApp(<Providers><Sidebar /><Home /><JoinHost /></Providers>);
    expect(screen.queryByTestId("sidebar-already")).toBeNull();
    await user.click(screen.getByTestId("home-already"));
    expect(screen.getByTestId("device-join-restore")).toHaveTextContent("Restore a backup");
  });

  it("the scanner reads the link, and the one screen names the profile, with the device's name and one button; a fresh profile joins here", async () => {
    asPixel();
    const device = code();
    fakeEngine.on("deviceEnrollReady", () => "ready");
    fakeEngine.on("deviceEnrollJoin", () => ({ role: "joiner", step: "connecting" }));
    fakeEngine.on("deviceEnrollView", () => ({ role: "joiner", step: "confirm", digits: "482913" }));
    fakeEngine.readClipboardText = vi.fn(async () => deviceLink(device, appLinkOrigin(), "Miguel").toUpperCase().replace("#MIGUEL#", "#Miguel#"));
    const { user } = renderApp(<Providers><Home /><JoinHost /></Providers>);
    await user.click(screen.getByTestId("home-already"));
    await user.click(screen.getByTestId("device-join-add"));
    await user.click(await screen.findByRole("button", { name: "Paste from clipboard" }));
    const form = await oneScreen();
    expect(screen.getByTestId("device-join")).toHaveTextContent("Add this phone to “Miguel”");
    expect(screen.getByTestId("device-join-name")).toHaveValue("Phone");
    await waitFor(() => expect(form).toHaveAttribute("data-place", "here"));
    expect(screen.queryByTestId("device-join-new-profile")).toBeNull();
    expect(within(form).getAllByRole("button").filter((b) => b.getAttribute("type") === "submit")).toHaveLength(1);
    await user.click(screen.getByTestId("device-join-next"));
    await waitFor(() => expect(fakeEngine.callsTo("deviceEnrollJoin")).toHaveLength(1));
    expect(fakeEngine.callsTo("deviceEnrollJoin")[0]).toMatchObject({ code: device.toUpperCase(), name: "Phone" });
    // Then the digits, with what to check in words, while the other device is asked.
    expect(await screen.findByTestId("device-join-digits", {}, { timeout: 3_000 })).toHaveTextContent("482 913");
    expect(screen.getByTestId("device-join")).toHaveTextContent("Check that your other device shows the same digits.");
    expect(listProfiles()).toHaveLength(1);
  });
});

describe("in a profile that holds something", () => {
  it("the one screen says a new profile is made; Add makes it with the code, the name and the profile, hands the lock over, and joins nothing here", async () => {
    asPixel();
    aChat();
    const hash = await hashPassword("a long lock password");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
    const reload = catchReload();
    const device = code();
    fakeEngine.on("deviceEnrollReady", () => "in-use");
    offerDeviceLink(deviceLink(device, appLinkOrigin(), "Miguel"));
    const { user } = renderApp(<JoinHost />);
    const form = await oneScreen();
    await waitFor(() => expect(form).toHaveAttribute("data-place", "new"));
    expect(screen.getByTestId("device-join-new-profile")).toHaveTextContent("Ghostly makes a new profile here for it. Your profile here stays as it is.");
    await user.click(screen.getByTestId("device-join-new-profile-info"));
    expect(screen.getByTestId("device-join")).toHaveTextContent("Switch between them in the profile menu.");
    await user.clear(screen.getByTestId("device-join-name"));
    await user.type(screen.getByTestId("device-join-name"), "Pixel");
    await user.click(screen.getByTestId("device-join-next"));
    const added = listProfiles().find((entry) => entry.name === "Miguel")!;
    expect(added).toBeDefined();
    expect(JSON.parse(sessionStorage.getItem(JOIN_REQUEST)!)).toEqual({ id: added.id, code: device, start: "go", name: "Pixel", profile: "Miguel" });
    // The new profile has the same lock, already passed in this tab: it opens without asking again.
    expect(JSON.parse(sessionStorage.getItem(HANDOVER)!)).toMatchObject({ profile: added.id, hash });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(fakeEngine.callsTo("deviceEnrollJoin")).toHaveLength(0);
    // This profile keeps its chat; the new one is empty.
    expect(listSessions()).toHaveLength(1);
    expect(localStorage.getItem(`${prefixOf(added.id)}chat1`)).toBeNull();
  });

  it("asked as ready, the engine's refusal on join still hands the code to a new profile: no dead end", async () => {
    const reload = catchReload();
    const device = code();
    fakeEngine.on("deviceEnrollReady", () => "ready");
    fakeEngine.on("deviceEnrollJoin", () => { throw new Error(IN_USE); });
    offerDeviceLink(device);
    const { user } = renderApp(<JoinHost />);
    const form = await oneScreen();
    // No profile name in the link: it says "your profile".
    expect(screen.getByTestId("device-join")).toHaveTextContent("Add this computer to your profile");
    await waitFor(() => expect(form).toHaveAttribute("data-place", "here"));
    await user.click(screen.getByTestId("device-join-next"));
    await waitFor(() => expect(sessionStorage.getItem(JOIN_REQUEST)).not.toBeNull());
    const added = listProfiles().find((entry) => entry.name === "From another device")!;
    expect(JSON.parse(sessionStorage.getItem(JOIN_REQUEST)!)).toMatchObject({ id: added.id, code: device, start: "go" });
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("an app with one profile only says the profile is in use: there is nowhere else to put the code", async () => {
    fakeEngine.features = { ...fakeEngine.features, profiles: false };
    fakeEngine.on("deviceEnrollReady", () => "in-use");
    offerDeviceLink(code());
    const { user } = renderApp(<JoinHost />);
    const form = await oneScreen();
    await waitFor(() => expect(form).toHaveAttribute("data-place", "nowhere"));
    await user.click(screen.getByTestId("device-join-next"));
    expect(await screen.findByTestId("device-join-error")).toHaveTextContent("This profile is in use here.");
    expect(listProfiles()).toHaveLength(1);
    expect(fakeEngine.callsTo("deviceEnrollJoin")).toHaveLength(0);
  });

  it("on the standby screen a code always goes to a new profile, without asking the engine", async () => {
    catchReload();
    offerDeviceLink(code());
    renderApp(<JoinHost standby />);
    const form = await oneScreen();
    await waitFor(() => expect(form).toHaveAttribute("data-place", "new"));
    expect(fakeEngine.callsTo("deviceEnrollReady")).toHaveLength(0);
  });
});

describe("every route lands on the one screen", () => {
  it("Add this device to another profile, in the profile switcher: the scanner, then the one screen", async () => {
    aChat();
    fakeEngine.on("deviceEnrollReady", () => "in-use");
    const glances = { current: listProfiles()[0], others: [], othersUnread: 0, othersFresh: 0 };
    const { user } = renderApp(<><ProfileSwitcherMenu variant="sheet" glances={glances} onClose={() => {}} /><JoinHost /></>);
    fakeEngine.readClipboardText = vi.fn(async () => code());
    await user.click(screen.getByRole("menuitem", { name: "Add this device to another profile" }));
    await user.click(await screen.findByRole("button", { name: "Paste from clipboard" }));
    const form = await oneScreen();
    await waitFor(() => expect(form).toHaveAttribute("data-place", "new"));
  });

  it("closing that scanner makes nothing", async () => {
    const before = listProfiles().length;
    const glances = { current: listProfiles()[0], others: [], othersUnread: 0, othersFresh: 0 };
    const { user } = renderApp(<><ProfileSwitcherMenu variant="popover" glances={glances} onClose={() => {}} /><JoinHost /></>);
    await user.click(screen.getByTestId("profile-switcher-join"));
    await user.click(await screen.findByRole("button", { name: "Close join" }));
    expect(screen.queryByTestId("device-join")).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste from clipboard" })).toBeNull();
    expect(listProfiles()).toHaveLength(before);
    expect(sessionStorage.getItem(JOIN_REQUEST)).toBeNull();
  });

  it("is under New profile in the profile list, where profiles can be made", async () => {
    const { user } = renderApp(<><Profile /><JoinHost /></>);
    await user.click(screen.getByTestId("profile-join-another"));
    expect(await screen.findByRole("button", { name: "Paste from clipboard" })).toBeInTheDocument();
  });

  it("Join on the chat list: a device code read there goes to the one screen, not to an error", async () => {
    const onClose = vi.fn();
    const device = code();
    fakeEngine.on("deviceEnrollReady", () => "in-use");
    const { user } = renderApp(<><JoinDialog onJoin={() => {}} onClose={onClose} /><JoinHost /></>);
    fakeEngine.readClipboardText = vi.fn(async () => deviceLink(device, appLinkOrigin(), "Work"));
    aChat();
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const form = await oneScreen();
    expect(form).toHaveAttribute("data-profile", "Work");
    expect(screen.getByTestId("device-join")).toHaveTextContent("Add this computer to “Work”");
  });

  const set = (devices: DeviceSetView["devices"]): DeviceSetView => ({ state: devices.length ? "active" : "single", devices } as DeviceSetView);

  it("Profile, Devices offers it while the profile has no other device, and not once it has", async () => {
    fakeEngine.on("deviceSet", () => set([]));
    const { user, unmount } = renderApp(<><DevicesSection /><JoinHost /></>);
    const row = await screen.findByTestId("device-join-another-row");
    expect(row).toHaveTextContent("Use this device with a profile from another device");
    await user.click(within(row).getByTestId("device-join-another-open"));
    expect(await screen.findByRole("button", { name: "Paste from clipboard" })).toBeInTheDocument();
    unmount();

    fakeEngine.on("deviceSet", () => set([
      { key: "D".repeat(43), name: "MacBook", slot: 0, self: true, active: true },
      { key: "P".repeat(43), name: "iPhone", slot: 1, self: false, active: false, status: "live" },
    ] as DeviceSetView["devices"]));
    renderApp(<DevicesSection />);
    await screen.findAllByTestId("device-row");
    expect(screen.queryByTestId("device-join-another-row")).toBeNull();
  });

  it("is not offered where an app has one profile only", async () => {
    fakeEngine.features = { ...fakeEngine.features, profiles: false };
    fakeEngine.on("deviceSet", () => set([]));
    renderApp(<DevicesSection />);
    await waitFor(() => expect(fakeEngine.callsTo("deviceSet").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("device-join-another-row")).toBeNull();
  });
});

describe("a device code opened as a link (the QR code, by a phone's camera)", () => {
  it("leaves the address at once, in any case, as a web+ghostly: link, and with the profile's name before it", () => {
    const device = code();
    window.history.replaceState(null, "", `#${device.toUpperCase()}`);
    takeDeviceLinkFromAddress();
    expect(window.location.hash).toBe("#/");
    expect(takeDeviceLink()).toEqual({ code: device.toUpperCase() });
    // Taken once.
    expect(takeDeviceLink()).toBeNull();

    window.history.replaceState(null, "", `#web%2Bghostly%3A${device}`);
    takeDeviceLinkFromAddress();
    expect(window.location.hash).toBe("#/");
    expect(takeDeviceLink()).toEqual({ code: device });

    for (const hash of [`#Ana%20Lu#${device.toUpperCase()}`, `#Ana%20Lu%23${device.toUpperCase()}`]) {
      window.history.replaceState(null, "", hash);
      takeDeviceLinkFromAddress();
      expect(window.location.hash).toBe("#/");
      expect(takeDeviceLink()).toEqual({ code: device.toUpperCase(), profile: "Ana Lu" });
    }
  });

  it("leaves a chat invite and a route alone, for the router", () => {
    window.history.replaceState(null, "", "#/settings");
    takeDeviceLinkFromAddress();
    expect(window.location.hash).toBe("#/settings");
    expect(takeDeviceLink()).toBeNull();
  });

  it("on a fresh install: the one screen, and the code is used after it in this profile, with the name as edited", async () => {
    const device = code();
    offerDeviceLink(device);
    fakeEngine.on("deviceEnrollReady", () => "ready");
    fakeEngine.on("deviceEnrollJoin", () => ({ role: "joiner", step: "connecting" }));
    const { user } = renderApp(<JoinHost />);
    await oneScreen();
    await user.clear(screen.getByTestId("device-join-name"));
    await user.type(screen.getByTestId("device-join-name"), "Pixel");
    await user.click(screen.getByTestId("device-join-next"));
    await waitFor(() => expect(fakeEngine.callsTo("deviceEnrollJoin")).toHaveLength(1));
    expect(fakeEngine.callsTo("deviceEnrollJoin")[0]).toMatchObject({ code: device, name: "Pixel" });
    expect(screen.queryByRole("textbox", { name: "Invite code" })).toBeNull();
    expect(await screen.findByTestId("device-join-connecting")).toHaveTextContent("Connecting to your other device…");
    expect(listProfiles()).toHaveLength(1);
  });

  it("a code the engine refuses is said in one line, with Scan a new code", async () => {
    offerDeviceLink(code());
    fakeEngine.on("deviceEnrollReady", () => "ready");
    fakeEngine.on("deviceEnrollJoin", () => { throw new Error("enroll-used: Another device used this code first."); });
    const { user } = renderApp(<JoinHost />);
    await oneScreen();
    await user.click(screen.getByTestId("device-join-next"));
    expect(await screen.findByTestId("device-join-error")).toHaveTextContent("Another device used this code first. Make a new one.");
    await user.click(screen.getByTestId("device-join-scan-again"));
    expect(await screen.findByRole("button", { name: "Paste from clipboard" })).toBeInTheDocument();
  });

  it("wallets still loading: Getting ready, and the join is asked again until they have", async () => {
    offerDeviceLink(code());
    fakeEngine.on("deviceEnrollReady", () => "loading");
    let tries = 0;
    fakeEngine.on("deviceEnrollJoin", () => {
      if (++tries < 2) throw new Error("enroll-loading: The wallets of this profile have not loaded yet.");
      return { role: "joiner", step: "connecting" };
    });
    const { user } = renderApp(<JoinHost />);
    const form = await oneScreen();
    await waitFor(() => expect(form).toHaveAttribute("data-place", "loading"));
    await user.click(screen.getByTestId("device-join-next"));
    expect(await screen.findByText("Getting ready…")).toBeInTheDocument();
    await waitFor(() => expect(tries).toBe(2), { timeout: 4_000 });
    expect(await screen.findByTestId("device-join-connecting")).toHaveAttribute("data-step", "connecting");
  });

  it("an expired code is said over the app, and nothing opens", async () => {
    offerDeviceLink(createDeviceInvite(new Uint8Array(32).fill(7), 1_000).code);
    renderApp(<JoinHost />);
    expect(await screen.findByTestId("device-link-invalid")).toHaveTextContent("This code ran out of time. Make a new one.");
    expect(screen.queryByTestId("device-join")).toBeNull();
  });

  it("the link names the profile before the code, which every reader takes after the last #; the QR keeps the code in capitals", () => {
    const device = code();
    const origin = appLinkOrigin();
    expect(deviceLink(device, origin)).toBe(`${origin}/#${device}`);
    expect(deviceLink(device, origin, "Ana Lu")).toBe(`${origin}/#Ana%20Lu#${device}`);
    expect(deviceLinkQr(device, origin, "Ana Lu")).toEqual([`${origin}/`.toUpperCase(), "#Ana%20Lu#", device.toUpperCase()]);
    expect(deviceLinkQr(device, origin)).toEqual([`${origin}/`.toUpperCase(), "#", device.toUpperCase()]);
    // A `#` in the name never splits the link; a long name is cut; any script goes.
    expect(readDeviceLink(deviceLink(device, origin, "A#B"))).toEqual({ code: device, profile: "AB" });
    expect(readDeviceLink(deviceLink(device, origin, "x".repeat(80))).profile).toHaveLength(32);
    expect(readDeviceLink(deviceLink(device, origin, "ミゲル 👻"))).toEqual({ code: device, profile: "ミゲル 👻" });
    expect(readDeviceLink(device)).toEqual({ code: device });
    expect(readDeviceLink(`${origin}/#${device}`)).toEqual({ code: device });
    // From the desktop app, which has no address another device opens: the public web app.
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    try { expect(appLinkOrigin()).toBe("https://app.ghostly.tools"); } finally { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); }
  });

  it("says phone, tablet or computer from what the device is", () => {
    expect(deviceNoun({ userAgent: PIXEL })).toBe("phone");
    expect(deviceNoun({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" })).toBe("phone");
    expect(deviceNoun({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 })).toBe("tablet");
    expect(deviceNoun({ userAgent: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/131.0 Safari/537.36" })).toBe("tablet");
    expect(deviceNoun({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("computer");
  });
});

describe("a profile made for a code", () => {
  it("goes straight on to the digits with the name given, without a screen to press", async () => {
    createProfile("Joining");
    sessionStorage.setItem(JOIN_REQUEST, JSON.stringify({ id: activeProfileId(), code: code(), start: "go", name: "Pixel", profile: "Miguel" }));
    fakeEngine.on("deviceEnrollJoin", () => ({ role: "joiner", step: "connecting" }));
    renderApp(<JoinHost />);
    await waitFor(() => expect(fakeEngine.callsTo("deviceEnrollJoin")).toHaveLength(1));
    expect(fakeEngine.callsTo("deviceEnrollJoin")[0]).toMatchObject({ name: "Pixel" });
    expect(screen.queryByTestId("device-join-confirm")).toBeNull();
    expect(screen.getByTestId("device-join")).toHaveTextContent("Add this computer to “Miguel”");
    expect(sessionStorage.getItem(JOIN_REQUEST)).toBeNull();
  });

  it("once added, opens the standby screen by itself, the lock handed over across that reload", async () => {
    const hash = await hashPassword("a long lock password");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
    const reload = catchReload();
    sessionStorage.setItem(JOIN_REQUEST, JSON.stringify({ id: activeProfileId(), code: code(), start: "go", name: "Pixel" }));
    fakeEngine.on("deviceEnrollJoin", () => ({ role: "joiner", step: "connecting" }));
    fakeEngine.on("deviceEnrollView", () => ({ role: "joiner", step: "done", device: "MacBook" }));
    // A headless test browser keeps its storage: nothing to warn about, so nothing to press.
    Object.defineProperty(navigator, "storage", { configurable: true, value: { persisted: async () => true, persist: async () => true } });
    try {
      renderApp(<JoinHost />);
      expect(await screen.findByTestId("device-join-done", {}, { timeout: 3_000 })).toHaveAttribute("data-step", "done");
      expect(screen.queryByTestId("device-join-continue")).toBeNull();
      await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 4_000 });
      expect(JSON.parse(sessionStorage.getItem(HANDOVER)!)).toMatchObject({ profile: activeProfileId(), hash });
    } finally { Reflect.deleteProperty(navigator, "storage"); }
  });

  it("reads requests of the older forms", () => {
    sessionStorage.setItem(JOIN_REQUEST, "abc");
    expect(takeJoinRequest("other")).toBeNull();
    expect(takeJoinRequest("abc")).toEqual({});
    sessionStorage.setItem(JOIN_REQUEST, JSON.stringify({ id: "abc", start: "name" }));
    expect(takeJoinRequest("abc")).toEqual({ start: "scan" });
    sessionStorage.setItem(JOIN_REQUEST, JSON.stringify({ id: "abc", start: "name", code: "ghostly1z" }));
    expect(takeJoinRequest("abc")).toEqual({ code: "ghostly1z" });
  });

  it("is not opened on a device on standby", () => {
    sessionStorage.setItem(JOIN_REQUEST, JSON.stringify({ id: activeProfileId(), code: code(), start: "go" }));
    renderApp(<JoinHost standby />);
    act(() => {});
    expect(screen.queryByTestId("device-join")).toBeNull();
  });
});

describe("the lock handed across one reload the app makes", () => {
  it("counts once, for that profile and that password, for a few seconds", () => {
    handOverUnlock("p1", "hash");
    expect(takeUnlockHandover("p1", "hash", Date.now() + 5_000)).toBe(true);
    // Used up (a second read in the same render gets the same answer; a later page does not).
    expect(takeUnlockHandover("p1", "hash", Date.now() + 60_000)).toBe(false);
    handOverUnlock("p1", "hash");
    expect(takeUnlockHandover("p2", "hash", Date.now() + 70_000)).toBe(false);
    handOverUnlock("p1", "hash");
    expect(takeUnlockHandover("p1", "other", Date.now() + 80_000)).toBe(false);
    handOverUnlock("p1", "hash");
    expect(takeUnlockHandover("p1", "hash", Date.now() + 16_000)).toBe(false);
    handOverUnlock("p1", null);
    expect(sessionStorage.getItem(HANDOVER)).toBeNull();
  });

  it("the lock screen starts unlocked with it, and locked without it", async () => {
    const hash = await hashPassword("a long lock password");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
    const Probe = () => { const { isLocked } = useLockScreen(); return <p data-testid="locked">{String(isLocked)}</p>; };
    const first = renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    first.unmount();
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ["Date"] });
    handOverUnlock(activeProfileId(), hash);
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(screen.getByTestId("locked")).toHaveTextContent("false");
  });
});

describe("the time left on the code", () => {
  it("reads as minutes and seconds, never below zero", () => {
    expect(timeLeft(600, 0)).toBe("10:00");
    expect(timeLeft(600, 18_500)).toBe("9:42");
    expect(timeLeft(600, 700_000)).toBe("0:00");
  });
});
