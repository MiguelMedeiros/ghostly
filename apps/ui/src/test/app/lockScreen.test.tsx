import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useLockScreen, useRingOnLockScreen, type LockedCall } from "../../contexts/LockScreenContext";
import { useSettings } from "../../contexts/SettingsContext";
import { useDialogFocus } from "../../hooks/useDismiss";
import { handOverCall, takeHandedCall } from "../../lib/lockedRing";
import { handOverUnlock } from "../../lib/lockHandover";
import { assertUnlocked, deleteProfile } from "../../lib/profileData";
import { createProfileBackup } from "../../lib/profileBackup";
import { activeProfileId, namespaceOf, setRunningProfile, settingsKeyFor } from "../../lib/profiles";
import { setServiceWindowsCloser } from "../../lib/serviceWindows";
import { hashPassword } from "../../lib/settings";
import { setStorageProfile } from "../../lib/storage";
import { renderApp } from "../render";

/*
 * One page for the whole file, and the order of these describes keeps what it holds from one to the next: the layers
 * the lock screen took (history's `ghostlyLayer`) and the unlock handover a page took (lockHandover.ts keeps its answer
 * for 2 s). The Back test goes first, before any lock screen is left open; a test that starts locked without a handover
 * goes where the last one taken for this profile was refused too.
 */

// covers: settings.lock.idle
describe("Escape on the lock screen", () => {
  /** A dialog of the app's own (Send files, a new wallet, Add identity...): a plain modal that Escape closes. */
  function Sheet() {
    const [open, setOpen] = useState(true);
    const ref = useRef<HTMLDivElement>(null);
    return open ? <SheetBox panel={ref} onClose={() => setOpen(false)} /> : null;
  }

  function SheetBox({ panel, onClose }: { panel: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
    useDialogFocus(panel, onClose);
    return <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Send files"><input aria-label="Caption" defaultValue="for you" /></div>;
  }

  function Lock() {
    const { isLocked, lock } = useLockScreen();
    return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
  }

  const { showModal, close } = HTMLDialogElement.prototype;
  const layerDepth = () => (history.state as Record<string, unknown> | null)?.ghostlyLayer;
  const lockField = () => screen.getByLabelText("Ghostly is locked").querySelector("input[type=password]") as HTMLInputElement;

  beforeEach(async () => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
    const hash = await hashPassword("pw");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), hash);
    renderApp(<LockScreenProvider><LockScreen /><Lock /><Sheet /></LockScreenProvider>);
  });
  afterEach(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
    localStorage.clear(); sessionStorage.clear();
  });

  it("leaves the app's dialog under the lock open, as it was", async () => {
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(lockField()).toHaveFocus();
    fireEvent.keyDown(lockField(), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Send files", hidden: true })).toBeInTheDocument();

    fireEvent.change(lockField(), { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(lockField().closest("form")!); });
    await screen.findByText("false");
    expect(screen.getByRole("dialog", { name: "Send files" })).toBeInTheDocument();
    expect(screen.getByLabelText("Caption")).toHaveValue("for you");
  });

  it("Back (Android's back gesture) leaves the dialog under the lock open too, and the app on its page", async () => {
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    // The lock takes an entry of its own once it is in.
    await waitFor(() => expect(layerDepth()).toBe(2));
    await act(async () => { history.back(); });
    await waitFor(() => expect(layerDepth()).toBe(1));
    expect(screen.getByTestId("lock")).toHaveTextContent("true");
    expect(screen.getByRole("dialog", { name: "Send files", hidden: true })).toBeInTheDocument();
    // It takes an entry again: the next Back is the lock screen's too, never the page's.
    await waitFor(() => expect(layerDepth()).toBe(2));

    fireEvent.change(lockField(), { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(lockField().closest("form")!); });
    await screen.findByText("false");
    expect(screen.getByLabelText("Caption")).toHaveValue("for you");
  });

  it("is the dialog's own once the app is unlocked: it closes it", () => {
    fireEvent.keyDown(screen.getByLabelText("Caption"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Send files" })).not.toBeInTheDocument();
  });
});

// covers: settings.lock.idle
describe("lock after the chosen time, whatever kept the page from counting it", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  function Probe() {
    const { isLocked } = useLockScreen();
    return <p data-testid="locked">{String(isLocked)}</p>;
  }

  const locked = () => screen.getByTestId("locked").textContent;

  /** The app open and unlocked, "lock after 5 minutes" on. */
  function open() {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), "x");
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(locked()).toBe("false");
  }

  /** What a sleeping device looks like to the page: the clock moves on, its timers do not. */
  const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);
  /** Time with the page running: clock and timers together. */
  const awake = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

  it("locks after the time with the page awake and nobody touching it, and not before", () => {
    open();
    awake(5 * MINUTE - 1000);
    expect(locked()).toBe("false");
    awake(1000);
    expect(locked()).toBe("true");
  });

  it("activity starts the time again", () => {
    open();
    awake(4 * MINUTE);
    act(() => { fireEvent.keyDown(window); });
    awake(4 * MINUTE);
    expect(locked()).toBe("false");
    awake(MINUTE);
    expect(locked()).toBe("true");
  });

  it("the first touch after hours asleep locks, and does not start the time again", () => {
    open();
    sleep(8 * HOUR);
    expect(locked()).toBe("false");
    act(() => { fireEvent.touchStart(window); });
    expect(locked()).toBe("true");
  });

  it.each(["visibilitychange", "focus", "pageshow"])("coming back after hours asleep locks before any touch (%s)", (event) => {
    open();
    sleep(8 * HOUR);
    act(() => { (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event)); });
    expect(locked()).toBe("true");
  });

  it("a device that woke with nobody touching it locks within half a minute", () => {
    open();
    awake(MINUTE);
    sleep(8 * HOUR);
    awake(30_000);
    expect(locked()).toBe("true");
  });

  it("coming back sooner than the chosen time keeps it open, and is not activity", () => {
    open();
    sleep(3 * MINUTE);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(locked()).toBe("false");
    awake(2 * MINUTE);
    expect(locked()).toBe("true");
  });

  it("a clock set back does not make the wait longer than the chosen time", () => {
    open();
    vi.setSystemTime(Date.now() - 8 * HOUR);
    act(() => { window.dispatchEvent(new Event("focus")); });
    awake(5 * MINUTE);
    expect(locked()).toBe("true");
  });
});

// covers: settings.lock.idle
describe("with the lock on, the app switcher's picture of the app shows no content", () => {
  const HOUR = 3_600_000;

  function Chat() {
    const { isLocked } = useLockScreen();
    return <p data-testid="locked">{String(isLocked)}</p>;
  }

  /** The app open and unlocked on a chat; "lock after 5 minutes" on unless `lockOn` is false. */
  function open(lockOn = true) {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: lockOn, passwordHash: "x", timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), "x");
    renderApp(<LockScreenProvider><LockScreen /><Chat /></LockScreenProvider>);
    expect(screen.getByTestId("locked")).toHaveTextContent("false");
  }

  let visibility: DocumentVisibilityState = "visible";
  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  };
  const cover = () => screen.queryByTestId("lock-cover");

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

  it("covers the app as it goes hidden, and back sooner than the time shows the chat again", () => {
    open();
    expect(cover()).not.toBeInTheDocument();
    setVisibility("hidden");
    expect(cover()).toBeInTheDocument();
    vi.setSystemTime(Date.now() + 60_000);
    setVisibility("visible");
    expect(cover()).not.toBeInTheDocument();
    expect(screen.getByTestId("locked")).toHaveTextContent("false");
  });

  it("back after the time, the cover gives way to the lock screen, never to the chat", () => {
    open();
    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 8 * HOUR);
    setVisibility("visible");
    expect(cover()).not.toBeInTheDocument();
    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("covers on pagehide too", () => {
    open();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(cover()).toBeInTheDocument();
  });

  it("on a phone, covers when the app loses the focus, not when a frame of the page takes it", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    open();
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(cover()).toBeInTheDocument();
    focused.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(cover()).not.toBeInTheDocument();

    const frame = document.createElement("iframe");
    vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
    focused.mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(cover()).not.toBeInTheDocument();
  });

  it("the cover goes over every layer the page draws: last in the top layer, and again over one opened while away", async () => {
    // happy-dom has no top layer: the popover API stands in, recording what was raised.
    const raised: Element[] = [];
    Object.assign(HTMLElement.prototype, { showPopover(this: HTMLElement) { raised.push(this); }, hidePopover() {} });
    const dialog = document.createElement("dialog"), list = document.createElement("div");
    try {
      open();
      setVisibility("hidden");
      expect(raised).toEqual([cover()]);
      // A dialog opened modal, then a popover (a select's list), while away: the cover goes over each.
      document.body.append(dialog, list);
      await act(async () => { dialog.setAttribute("open", ""); await vi.advanceTimersByTimeAsync(0); });
      expect(raised).toEqual([cover(), cover()]);
      act(() => { list.dispatchEvent(new Event("toggle")); });
      expect(raised).toEqual([cover(), cover(), cover()]);
      // Its own toggle does not raise it again.
      act(() => { cover()!.dispatchEvent(new Event("toggle")); });
      expect(raised).toHaveLength(3);
    } finally {
      dialog.remove(); list.remove();
      delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
      delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
    }
  });

  it("away while locked, the cover goes over the lock screen too: a layer left open under it stays out of the picture", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    // A page started without a handover: past the moment an earlier test's page took its own.
    vi.setSystemTime(Date.now() + 10_000);
    renderApp(<LockScreenProvider><LockScreen /><Chat /></LockScreenProvider>);
    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(cover()).not.toBeInTheDocument();
    setVisibility("hidden");
    expect(cover()).toBeInTheDocument();
    setVisibility("visible");
    expect(cover()).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("with the lock off, covers nothing", () => {
    open(false);
    setVisibility("hidden");
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(cover()).not.toBeInTheDocument();
  });
});

// covers: services.desktop-viewer
describe("a contact's app window open when the profile locks", () => {
  function Probe() {
    const { isLocked, lock } = useLockScreen();
    return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
  }

  afterEach(() => { setServiceWindowsCloser(null); localStorage.clear(); sessionStorage.clear(); });

  it("closes: the page does not go on serving it behind the lock", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), "x");
    const close = vi.fn();
    setServiceWindowsCloser(close);
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(screen.getByTestId("lock").textContent).toBe("false");
    expect(close).not.toHaveBeenCalled();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(screen.getByTestId("lock").textContent).toBe("true");
    expect(close).toHaveBeenCalledOnce();
  });
});

// covers: settings.lock.now
describe("Lock Now with the app open in two tabs", () => {
  function Probe({ tab }: { tab: string }) {
    const { isLocked, lock } = useLockScreen();
    return <button data-testid={`lock-${tab}`} onClick={lock}>{String(isLocked)}</button>;
  }

  /** A tab of the app (the extension opens several), unlocked: each takes the lock passed across its reload. */
  function openTab(tab: string) {
    handOverUnlock(activeProfileId(), "x");
    renderApp(<LockScreenProvider><Probe tab={tab} /></LockScreenProvider>);
    expect(screen.getByTestId(`lock-${tab}`).textContent).toBe("false");
  }

  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("locks the other tab too", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    openTab("a");
    openTab("b");
    act(() => { fireEvent.click(screen.getByTestId("lock-a")); });
    expect(screen.getByTestId("lock-a").textContent).toBe("true");
    await waitFor(() => expect(screen.getByTestId("lock-b").textContent).toBe("true"));
  });
});

// covers: settings.lock.now
describe("the lock with the app open in two tabs", () => {
  const KEY = "ghostly_app_settings";

  /** A tab of the app (the extension opens several): Lock Now, a password set here, and the sounds switch. */
  function Tab({ tab }: { tab: string }) {
    const { isLocked, lock } = useLockScreen();
    const { settings, updateLockScreen, updateNotifications } = useSettings();
    return (
      <>
        <button data-testid={`lock-${tab}`} data-hash={settings.lockScreen.passwordHash ?? ""} onClick={lock}>{String(isLocked)}</button>
        <button data-testid={`password-${tab}`} onClick={() => updateLockScreen({ enabled: true, passwordHash: "new" })} />
        <button data-testid={`sounds-${tab}`} onClick={() => updateNotifications({ soundEnabled: !settings.notifications.soundEnabled })} />
      </>
    );
  }

  function openTab(tab: string) {
    handOverUnlock(activeProfileId(), stored().lockScreen?.passwordHash);
    renderApp(<LockScreenProvider><Tab tab={tab} /></LockScreenProvider>);
    expect(screen.getByTestId(`lock-${tab}`).textContent).toBe("false");
  }

  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as { lockScreen?: { enabled?: boolean; passwordHash?: string | null }; notifications?: { soundEnabled?: boolean } };
  const click = (id: string) => act(() => { fireEvent.click(screen.getByTestId(id)); });
  /** What the browser tells the other tabs when one saves the settings. */
  const otherTabSaved = () => act(() => { window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: localStorage.getItem(KEY) })); });

  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("a password set in one tab: Lock Now there locks the tab opened before it", async () => {
    openTab("a");
    openTab("b");
    click("password-a");
    expect(stored().lockScreen?.passwordHash).toBe("new");
    click("lock-a");
    expect(screen.getByTestId("lock-a").textContent).toBe("true");
    await waitFor(() => expect(screen.getByTestId("lock-b").textContent).toBe("true"));
  });

  it("a setting saved in the tab opened before keeps the password set in the other", () => {
    openTab("a");
    openTab("b");
    click("password-a");
    click("sounds-b");
    expect(stored().notifications?.soundEnabled).toBe(false);
    expect(stored().lockScreen).toMatchObject({ enabled: true, passwordHash: "new" });
  });

  it("a password changed in another tab is not brought back by a setting saved in this one", () => {
    localStorage.setItem(KEY, JSON.stringify({ lockScreen: { enabled: true, passwordHash: "old", timeoutMinutes: 5 } }));
    openTab("b");
    localStorage.setItem(KEY, JSON.stringify({ lockScreen: { enabled: true, passwordHash: "changed", timeoutMinutes: 5 } }));
    click("sounds-b");
    expect(stored().lockScreen?.passwordHash).toBe("changed");
  });

  it("takes a password set in another tab as it lands", () => {
    openTab("b");
    localStorage.setItem(KEY, JSON.stringify({ lockScreen: { enabled: true, passwordHash: "new", timeoutMinutes: 5 } }));
    otherTabSaved();
    expect(screen.getByTestId("lock-b").dataset.hash).toBe("new");
  });
});

// covers: settings.lock.idle
describe("the lock screen goes over every layer of the app, and only the password reaches through", () => {
  /*
   * happy-dom has no top layer: showModal() and close() stand in, recording which dialog went last into it (the one
   * drawn over the others, the only one that takes the focus and the keys) and firing `close` as the browser does.
   */
  const { showModal, close } = HTMLDialogElement.prototype;
  let shown: HTMLDialogElement[] = [];
  const top = () => shown.filter((dialog) => dialog.open).pop();

  function Chat() {
    const { isLocked, lock } = useLockScreen();
    return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
  }

  /** The app open and unlocked with "pw", a dialog of its own open as modal over the chat, portalled to the body. */
  async function openWithDialog() {
    const hash = await hashPassword("pw");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), hash);
    renderApp(<LockScreenProvider><LockScreen /><Chat /></LockScreenProvider>);
    const dialog = document.createElement("dialog");
    dialog.innerHTML = "<input data-testid='other-field'>";
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  const LOCKED = "Ghostly is locked";
  const lockScreen = () => screen.getByLabelText(LOCKED) as HTMLDialogElement;

  beforeEach(() => {
    shown = [];
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      shown = [...shown.filter((dialog) => dialog !== this), this];
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  });
  afterEach(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
    document.querySelectorAll("body > dialog").forEach((dialog) => dialog.remove());
    localStorage.clear(); sessionStorage.clear();
  });

  it("locking over an open dialog puts the lock screen last in the top layer, its password field focused", async () => {
    const other = await openWithDialog();
    expect(top()).toBe(other);
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(lockScreen().tagName).toBe("DIALOG");
    expect(top()).toBe(lockScreen());
    expect(document.activeElement).toBe(lockScreen().querySelector("input[type=password]"));
  });

  it("Escape does not close it, and a close the page can't refuse shows it again at once", async () => {
    await openWithDialog();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    const escape = new Event("cancel", { cancelable: true });
    act(() => { lockScreen().dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    act(() => { lockScreen().close(); });
    expect(lockScreen().open).toBe(true);
    expect(top()).toBe(lockScreen());
  });

  it("a dialog or popover opened while locked goes under it", async () => {
    await openWithDialog();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    const late = document.createElement("dialog");
    document.body.append(late);
    await act(async () => { late.showModal(); late.setAttribute("open", ""); await Promise.resolve(); });
    expect(top()).toBe(lockScreen());
    const list = document.createElement("div");
    document.body.append(list);
    shown = shown.filter((dialog) => dialog !== lockScreen()).concat(late);
    act(() => { list.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" })); });
    expect(top()).toBe(lockScreen());
  });

  it("the right password takes it away, and the dialog under it is as it was", async () => {
    const other = await openWithDialog();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    const field = lockScreen().querySelector("input[type=password]")!;
    fireEvent.change(field, { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(field.closest("form")!); });
    await screen.findByText("false");
    expect(screen.queryByLabelText(LOCKED)).not.toBeInTheDocument();
    expect(top()).toBe(other);
  });
});

// covers: profiles.lock, profiles.delete
describe("every check of a profile's lock password is paced, per profile", () => {
  /** Another profile of this space, with a lock. */
  const OTHER = "abcdefghij";
  const RIGHT = "the right one";

  /** The oldest stored form of a lock password (unsalted SHA-256): quick to check here, and still accepted. */
  async function quickHash(password: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function lockWith(id: string, password: string) {
    localStorage.setItem(settingsKeyFor(id), JSON.stringify({ lockScreen: { enabled: true, passwordHash: await quickHash(password), timeoutMinutes: 5 } }));
  }

  /** This page as profile `id` (the default profile: ""). */
  function runAs(id: string) {
    setRunningProfile(id || undefined);
    setStorageProfile(namespaceOf(id));
  }

  const seen: { lock?: ReturnType<typeof useLockScreen> } = {};
  function Probe() {
    const lock = useLockScreen();
    useEffect(() => { seen.lock = lock; });
    return null;
  }
  const lockScreen = { unlock: (password: string) => seen.lock!.unlock(password), get retryAt() { return seen.lock!.retryAt; } };
  function openLockScreen() {
    return renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
  }

  const tries = { delete: (password: string) => deleteProfile(OTHER, password), backup: (password: string) => createProfileBackup("a long backup passphrase", OTHER, password) };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    runAs("");
    await lockWith(OTHER, RIGHT);
  });
  afterEach(() => { vi.useRealTimers(); runAs(""); localStorage.clear(); });

  it.each(Object.keys(tries) as (keyof typeof tries)[])("another profile's %s: after three wrong passwords even the right one waits", async (way) => {
    for (let i = 0; i < 3; i++) await expect(tries[way](`wrong ${i}`)).rejects.toThrow("Wrong lock password for that profile");
    await expect(tries[way](RIGHT)).rejects.toThrow("Too many attempts. Try again in 1 s");
    await expect(assertUnlocked(OTHER, RIGHT)).rejects.toThrow(/Too many attempts/);
    vi.setSystemTime(Date.now() + 1_000);
    await expect(assertUnlocked(OTHER, RIGHT)).resolves.toBeUndefined();
  });

  it("the wait doubles with each wrong password, up to five minutes", async () => {
    for (let i = 0; i < 3; i++) await expect(assertUnlocked(OTHER, "wrong")).rejects.toThrow();
    for (const seconds of [2, 4, 8, 16, 32, 64, 128, 256, 300, 300]) {
      vi.setSystemTime(Date.now() + 300_000);
      await expect(assertUnlocked(OTHER, "wrong")).rejects.toThrow("Wrong lock password for that profile");
      await expect(assertUnlocked(OTHER, RIGHT)).rejects.toThrow(`Too many attempts. Try again in ${seconds} s`);
    }
  });

  it("the Delete dialog shows the wait and holds Delete and Save until it is over", async () => {
    const { user } = renderApp(<DeleteProfileDialog entry={{ id: OTHER, name: "Work", createdAt: 0 }} onClose={() => {}} />);
    await user.type(screen.getByTestId("delete-profile-confirm"), "Work");
    const password = screen.getByTestId("delete-profile-password");
    for (let i = 0; i < 3; i++) {
      await user.clear(password);
      await user.type(password, `wrong ${i}`);
      await user.click(screen.getByTestId("delete-profile-go"));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Try again in 1 s");
    // Pressed, it keeps the focus through the wait: off by aria-disabled.
    expect(screen.getByTestId("delete-profile-go")).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "Download a backup first" }));
    await user.type(screen.getByLabelText("Backup passphrase"), "a long backup passphrase");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("one profile's right password leaves another's wait as it was", async () => {
    await lockWith("", "mine");
    for (let i = 0; i < 3; i++) await expect(assertUnlocked(OTHER, "wrong")).rejects.toThrow();
    const view = openLockScreen();
    await act(async () => { expect(await lockScreen.unlock("mine")).toBe(true); });
    view.unmount();
    await expect(assertUnlocked(OTHER, RIGHT)).rejects.toThrow(/Too many attempts/);
  });

  it("the lock screen's wait is the profile's own: another profile's right password does not clear it", async () => {
    await lockWith("", "mine");
    runAs(OTHER);
    let view = openLockScreen();
    for (let i = 0; i < 3; i++) await act(async () => { expect(await lockScreen.unlock("wrong")).toBe(false); });
    expect(lockScreen.retryAt).toBeGreaterThan(Date.now());
    view.unmount();

    runAs("");
    view = openLockScreen();
    expect(lockScreen.retryAt).toBeNull();
    await act(async () => { expect(await lockScreen.unlock("mine")).toBe(true); });
    view.unmount();

    runAs(OTHER);
    openLockScreen();
    expect(lockScreen.retryAt).toBeGreaterThan(Date.now());
    await act(async () => { expect(await lockScreen.unlock(RIGHT)).toBe(false); });
  });

  it("a wait kept before profiles had their own is the first profile's", async () => {
    localStorage.setItem("ghostly_lock_attempts", JSON.stringify({ failures: 3, retryAt: Date.now() + 1_000 }));
    await lockWith("", "mine");
    const view = openLockScreen();
    expect(lockScreen.retryAt).toBeGreaterThan(Date.now());
    view.unmount();
    runAs(OTHER);
    openLockScreen();
    expect(lockScreen.retryAt).toBeNull();
  });
});

// covers: calls.lock-ring-start
describe("a call answered on the lock screen before the first unlock, handed to the unlocked chat", () => {
  const offer = (ts: number) => JSON.stringify({ t: "o", ts, u: "abcd", p: "a".repeat(22), f: "0".repeat(64), s: "actpass" });

  afterEach(() => { vi.useRealTimers(); takeHandedCall("chat-1", null); });

  it("is answered once, by its own chat, as it came", () => {
    const a = offer(Date.now());
    handOverCall("chat-1", a, true);
    expect(takeHandedCall("chat-2", a)).toBeUndefined();
    expect(takeHandedCall("chat-1", a)).toBe(true);
    expect(takeHandedCall("chat-1", a)).toBeUndefined();
  });

  it("never answers a later call: a handover nobody took is gone after one ring", () => {
    vi.useFakeTimers();
    const a = offer(Date.now());
    handOverCall("chat-1", a, false);
    vi.advanceTimersByTime(61_000);
    expect(takeHandedCall("chat-1", a)).toBeUndefined();
  });

  it("answers only the offer it was pressed for: another call ringing in that chat just rings", () => {
    const now = Date.now();
    handOverCall("chat-1", offer(now - 5_000), true);
    expect(takeHandedCall("chat-1", offer(now))).toBeUndefined();
    // Dropped, not kept for later: the first offer coming back answers nothing either.
    expect(takeHandedCall("chat-1", offer(now - 5_000))).toBeUndefined();
  });

  it("hands nothing over without the offer", () => {
    handOverCall("chat-1", null, true);
    expect(takeHandedCall("chat-1", offer(Date.now()))).toBeUndefined();
  });
});

// covers: calls.lock-ring
// Starts locked, with no handover: after the paced checks, whose lock screens took none for this profile.
describe("a chat's ringing call reaches the lock screen", () => {
  /** A chat whose call rings (or not): what `Chat` does with `useRingOnLockScreen`. */
  function RingingChat({ call }: { call: LockedCall | null }) {
    useRingOnLockScreen(call);
    return null;
  }

  const call = (over: Partial<LockedCall> = {}): LockedCall =>
    ({ id: "chat-1", name: "Casper", named: true, hasVideo: false, onCall: false, answer: vi.fn(), decline: vi.fn(), ...over });

  afterEach(() => localStorage.clear());

  it("shows while the chat rings, follows what it shows, and goes when it stops; the latest answer is the one pressed", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    const first = call();
    const { rerender, user } = renderApp(<LockScreenProvider><LockScreen /><RingingChat call={first} /></LockScreenProvider>);
    expect(screen.getByTestId("lock-call-name")).toHaveTextContent("Casper");

    // A new render of the chat (new functions, same call): the screen keeps the card, and presses the latest.
    const again = call();
    rerender(<LockScreenProvider><LockScreen /><RingingChat call={again} /></LockScreenProvider>);
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(again.decline).toHaveBeenCalledOnce();
    expect(first.decline).not.toHaveBeenCalled();

    // The name changes (the contact's face came): the card follows.
    rerender(<LockScreenProvider><LockScreen /><RingingChat call={call({ name: "Slimer" })} /></LockScreenProvider>);
    expect(screen.getByTestId("lock-call-name")).toHaveTextContent("Slimer");

    act(() => rerender(<LockScreenProvider><LockScreen /><RingingChat call={null} /></LockScreenProvider>));
    expect(screen.queryByTestId("lock-call")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });
});

// covers: settings.lock.idle
// Last in the file: the browser host it sets stays set for the rest of the page.
describe("with the lock on, the system's app switcher keeps no picture of the app (Android)", () => {
  /** Turns the lock off and on again, as Settings > Privacy does. */
  function Switch() {
    const { updateLockScreen } = useSettings();
    return (
      <>
        <button data-testid="off" onClick={() => updateLockScreen({ enabled: false })} />
        <button data-testid="on" onClick={() => updateLockScreen({ enabled: true })} />
      </>
    );
  }

  function open(lockOn: boolean, passwordHash = "x") {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: lockOn, passwordHash, timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), passwordHash);
    renderApp(<LockScreenProvider><Switch /></LockScreenProvider>);
  }

  let hide: ReturnType<typeof vi.fn<(on: boolean) => Promise<void>>>;
  beforeEach(() => {
    hide = vi.fn(async (_on: boolean) => {});
    setBrowserHost({ hideFromSwitcher: hide } as Partial<BrowserHost> as BrowserHost);
  });
  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("tells the host as the app opens with the lock on, and again as the lock goes off and on", () => {
    open(true);
    expect(hide).toHaveBeenLastCalledWith(true);
    act(() => screen.getByTestId("off").click());
    expect(hide).toHaveBeenLastCalledWith(false);
    act(() => screen.getByTestId("on").click());
    expect(hide).toHaveBeenLastCalledWith(true);
  });

  it("with no lock set, asks for nothing to be hidden", () => {
    open(false);
    expect(hide).not.toHaveBeenCalledWith(true);
  });

  it("a lock turned on with no password hides nothing", () => {
    open(true, "");
    expect(hide).not.toHaveBeenCalledWith(true);
  });
});
