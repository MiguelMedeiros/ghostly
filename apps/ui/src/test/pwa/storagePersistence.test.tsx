import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupDue } from "@ghostly/browser/shared/backupReminder";
import { BackupReminder } from "../../components/wallet/BackupReminder";
import { StorageKeeper } from "../../components/StorageKeeper";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { setStorageProfile } from "../../lib/storage";
import {
  considerPersist, reconsiderPersist, refreshStorageProtection, requestPersist, resetStoragePersistence, shouldAskPersist, storageEstimate,
  storageProtection, type PersistMoment,
} from "../../lib/storagePersistence";
import { Settings } from "../../pages/Settings";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, REAL_MINT } from "../payments/fixtures";

// covers: app.storage.persist

/*
 * Asking the browser to keep the app's storage (lib/storagePersistence): when the app asks, that it asks once, what
 * makes it ask again, who never asks, and what Settings and the backup reminder say for each answer.
 */

const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** The browser's storage manager, scripted: whether it protects already, and what it answers when asked. */
function browserStorage({ persisted = false, grants = false, usage = 3 * 1024 * 1024, quota = 2 * 1024 * 1024 * 1024 } = {}) {
  const state = { persisted, grants };
  const storage = {
    state,
    persisted: vi.fn(async () => state.persisted),
    persist: vi.fn(async () => (state.persisted = state.persisted || state.grants)),
    estimate: vi.fn(async () => ({ usage, quota })),
  };
  Object.defineProperty(navigator, "storage", { configurable: true, value: storage });
  return storage;
}
const noStorage = () => Object.defineProperty(navigator, "storage", { configurable: true, value: undefined });
const notifications = (permission: NotificationPermission) => vi.stubGlobal("Notification", { permission });
/** Running as the installed app (its own window). Other media queries keep their real answer. */
function installed() {
  const real = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => query.includes("standalone") ? { matches: true } as MediaQueryList : real(query));
}
const asBrowser = (userAgent: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
const acted = (isActive: boolean) => Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive } });

beforeEach(() => notifications("default"));
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  delete (navigator as { storage?: unknown }).storage;
  delete (navigator as { userActivation?: unknown }).userActivation;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setStorageProfile("");
  resetStoragePersistence();
  localStorage.clear();
});

describe("when to ask the browser to keep the storage", () => {
  const moment = (over: Partial<PersistMoment> = {}): PersistMoment => ({
    desktop: false, supported: true, persisted: false, hasData: true, installed: false, notifications: false, prompts: false, gesture: false, asked: null, ...over,
  });
  const asked = (over: Partial<NonNullable<PersistMoment["asked"]>> = {}) => ({ at: 1, granted: false, installed: false, notifications: false, ...over });

  it("asks once the profile holds something, never on a cold first visit", () => {
    expect(shouldAskPersist(moment())).toBe(true);
    expect(shouldAskPersist(moment({ hasData: false }))).toBe(false);
  });

  it("never on Desktop, where it is missing, or when protected already", () => {
    expect(shouldAskPersist(moment({ desktop: true }))).toBe(false);
    expect(shouldAskPersist(moment({ supported: false }))).toBe(false);
    expect(shouldAskPersist(moment({ persisted: true }))).toBe(false);
  });

  it("asks once, and again only after the app was installed or notifications were allowed", () => {
    expect(shouldAskPersist(moment({ asked: asked() }))).toBe(false);
    expect(shouldAskPersist(moment({ asked: asked(), installed: true }))).toBe(true);
    expect(shouldAskPersist(moment({ asked: asked(), notifications: true }))).toBe(true);
    // Asked when it was installed and allowed to notify already: nothing changed since.
    expect(shouldAskPersist(moment({ asked: asked({ installed: true, notifications: true }), installed: true, notifications: true }))).toBe(false);
    expect(shouldAskPersist(moment({ asked: asked({ installed: true }), installed: true, notifications: true }))).toBe(true);
  });

  it("where the browser prompts (Firefox), only right after the person did something", () => {
    expect(shouldAskPersist(moment({ prompts: true }))).toBe(false);
    expect(shouldAskPersist(moment({ prompts: true, gesture: true }))).toBe(true);
  });
});

describe("asking the browser", () => {
  it("a new profile with nothing in it is not asked for; the first chat or wallet is", async () => {
    const storage = browserStorage({ grants: true });
    await considerPersist(false);
    expect(storage.persist).not.toHaveBeenCalled();
    expect(storageProtection()).toBe("unprotected");
    await considerPersist(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
    expect(storageProtection()).toBe("protected");
    // Protected: nothing more to ask.
    await considerPersist(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it("a browser that says no is not asked again, on this page or the next", async () => {
    const storage = browserStorage();
    await considerPersist(true);
    await considerPersist(true);
    resetStoragePersistence(); // a new page: only what the browser remembers is left
    await considerPersist(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
    expect(storageProtection()).toBe("unprotected");
  });

  it("asks again once notifications are allowed, and once the app is installed", async () => {
    const storage = browserStorage();
    await considerPersist(true);
    notifications("granted");
    await reconsiderPersist();
    expect(storage.persist).toHaveBeenCalledTimes(2);
    await reconsiderPersist();
    expect(storage.persist).toHaveBeenCalledTimes(2);
    installed();
    storage.state.grants = true;
    await reconsiderPersist();
    expect(storage.persist).toHaveBeenCalledTimes(3);
    expect(storageProtection()).toBe("protected");
  });

  it("each profile asks for itself", async () => {
    const storage = browserStorage();
    await considerPersist(true);
    setStorageProfile("work");
    await considerPersist(true);
    await considerPersist(true);
    expect(storage.persist).toHaveBeenCalledTimes(2);
  });

  it("the Desktop app never asks and has no answer to show", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    const storage = browserStorage({ grants: true });
    await considerPersist(true);
    await requestPersist();
    await refreshStorageProtection();
    expect(storage.persist).not.toHaveBeenCalled();
    expect(storageProtection()).toBeNull();
  });

  it("a browser without the API is not asked: not supported", async () => {
    noStorage();
    await considerPersist(true);
    expect(storageProtection()).toBe("unsupported");
  });

  it("Firefox prompts: not at the start of a page, only after a click, or from Settings", async () => {
    asBrowser(FIREFOX);
    const storage = browserStorage();
    acted(false);
    await considerPersist(true);
    expect(storage.persist).not.toHaveBeenCalled();
    // Not asked, so nothing is remembered: the click that makes the next chat still asks.
    acted(true);
    await considerPersist(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
    await considerPersist(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
    // The button in Settings asks whatever was asked before.
    storage.state.grants = true;
    await requestPersist();
    expect(storage.persist).toHaveBeenCalledTimes(2);
    expect(storageProtection()).toBe("protected");
  });

  it("reads what is used and what is available", async () => {
    browserStorage({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 });
    await refreshStorageProtection();
    expect(storageEstimate()).toEqual({ used: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 });
  });
});

describe("the app asks by itself", () => {
  it("not for an empty profile; once a chat exists; and for a wallet", async () => {
    const storage = browserStorage({ grants: true });
    const { rerender, engine } = renderApp(<StorageKeeper hasChats={false} />);
    await waitFor(() => expect(storageProtection()).toBe("unprotected"));
    expect(storage.persist).not.toHaveBeenCalled();
    rerender(<StorageKeeper hasChats />);
    await waitFor(() => expect(storage.persist).toHaveBeenCalledTimes(1));

    storage.state.persisted = false;
    localStorage.clear();
    resetStoragePersistence();
    rerender(<StorageKeeper hasChats={false} />);
    act(() => engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 50)] }) }));
    await waitFor(() => expect(storage.persist).toHaveBeenCalledTimes(2));
  });
});

describe("Settings: storage on this device", () => {
  const open = () => renderApp(
    <LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
    { route: "/settings" },
  );
  const row = () => screen.findByTestId("settings-storage-protection");

  it("protected: says so, with what is used of what is available", async () => {
    browserStorage({ persisted: true });
    const { user } = open();
    expect(await row()).toHaveTextContent("Storage on this device");
    expect(screen.getByTestId("settings-storage-state")).toHaveAttribute("data-state", "protected");
    expect(screen.getByTestId("settings-storage-state")).toHaveTextContent("Protected");
    expect(await row()).toHaveTextContent("This browser keeps Ghostly's data until you remove it.");
    await waitFor(() => expect(screen.getByTestId("settings-storage-used")).toHaveTextContent("3 MB of 2 GB"));
    expect(screen.queryByTestId("settings-storage-protect")).not.toBeInTheDocument();
    await user.click((await row()).querySelector("[data-testid=row-info]")!);
    expect(await row()).toHaveTextContent("Keep a backup of your profile.");
  });

  it("not protected: one line, what to do behind the ⓘ, and no button where the browser answers by itself", async () => {
    browserStorage();
    const { user } = open();
    await waitFor(() => expect(screen.getByTestId("settings-storage-state")).toHaveTextContent("Not protected"));
    expect(await row()).toHaveTextContent("This browser may clear Ghostly's data when the device runs low on space.");
    expect(await row()).not.toHaveTextContent("Install Ghostly");
    await user.click((await row()).querySelector("[data-testid=row-info]")!);
    expect(await row()).toHaveTextContent("Install Ghostly (add it to the Home Screen), allow notifications, and keep a backup of your profile.");
    expect(await row()).not.toHaveTextContent("Safari");
    expect(screen.queryByTestId("settings-storage-protect")).not.toBeInTheDocument();
  });

  it("not supported: says the browser does not tell, and keeps the plain size", async () => {
    noStorage();
    open();
    await waitFor(() => expect(screen.getByTestId("settings-storage-state")).toHaveAttribute("data-state", "unsupported"));
    expect(await row()).toHaveTextContent("This browser does not say if it keeps Ghostly's data.");
    expect(screen.getByTestId("settings-storage-used")).not.toHaveTextContent(" of ");
  });

  it("Safari on an iPhone: the ⓘ adds the 7 days", async () => {
    asBrowser(IPHONE);
    browserStorage();
    const { user } = open();
    await user.click((await row()).querySelector("[data-testid=row-info]")!);
    expect(await row()).toHaveTextContent("Safari also deletes a website's data after 7 days without a visit");
  });

  it("Firefox: a Protect button asks, and the line follows the answer", async () => {
    asBrowser(FIREFOX);
    const storage = browserStorage({ grants: true });
    const { user } = open();
    await user.click(await screen.findByTestId("settings-storage-protect"));
    await waitFor(() => expect(screen.getByTestId("settings-storage-state")).toHaveTextContent("Protected"));
    expect(storage.persist).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("settings-storage-protect")).not.toBeInTheDocument();
  });

  it("the Desktop app shows no such line", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    const storage = browserStorage();
    open();
    await screen.findByTestId("settings-storage-used");
    await waitFor(() => expect(storage.estimate).not.toHaveBeenCalled());
    expect(screen.queryByTestId("settings-storage-protection")).not.toBeInTheDocument();
  });
});

describe("the backup reminder where the browser may clear the data", () => {
  const due: BackupDue = { id: "cashu:mainnet", type: "cashu", backup: "profile" };
  const card = () => renderApp(<BackupReminder due={due} onBackUp={() => {}} onLater={() => {}} />);

  it("says so in its one line, on the same card", async () => {
    browserStorage();
    await refreshStorageProtection();
    card();
    expect(screen.getByTestId("backup-reminder")).toHaveTextContent("Back it up so you don't lose it if this device is lost or this browser clears its data.");
    expect(screen.getAllByTestId("backup-reminder")).toHaveLength(1);
  });

  it("keeps its usual line where the storage is protected, or the browser does not say", async () => {
    browserStorage({ persisted: true });
    await refreshStorageProtection();
    card();
    expect(screen.getByTestId("backup-reminder")).toHaveTextContent("Back it up so you don't lose it if this device is lost.");
  });
});
