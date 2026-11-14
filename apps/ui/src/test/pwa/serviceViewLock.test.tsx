import { act, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { setServiceWindowsCloser } from "../../lib/serviceWindows";
import { openServiceView } from "../../../../web/src/svc/opener";
import { SERVICE_VIEW_ID, closeServiceView, parseServicesHost } from "../../../../web/src/svc/protocol";
import { renderApp } from "../render";

// covers: settings.lock.idle

/**
 * A person using a contact's app on the web is using Ghostly: their taps and keys go to the app's frame, never to the
 * Ghostly page, and the lock locked them out after its time and closed the app with what they typed. The browser's
 * activation, which real input in a frame gives the page above it, counts; left alone, the lock comes as before.
 */
const MINUTE = 60_000;
const words = { unreachable: "", failed: "", close: "Close", callOn: "", tooSlow: "", offline: "", retry: "", blocked: "", unguarded: "", label: "Demo", owner: "Not Ghostly", openLink: (site: string) => `Open ${site}`, hostError: () => null };
const activation = { isActive: false };

function Probe() {
  const { isLocked } = useLockScreen();
  return <p data-testid="locked">{String(isLocked)}</p>;
}

const locked = () => screen.getByTestId("locked").textContent;
const awake = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** A tap in the app: the page is active for the next 5 seconds, as Chromium keeps it. */
const tap = async () => {
  activation.isActive = true;
  await awake(5_000);
  activation.isActive = false;
};

beforeAll(() => {
  // happy-dom would load the bridge page from the network: nothing here needs it.
  const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
  if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
});

beforeEach(async () => {
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
  activation.isActive = false;
  vi.useFakeTimers();
  // The web host's: the lock closes the view (apps/web/src/host.ts).
  setServiceWindowsCloser(closeServiceView);
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 1 } }));
  handOverUnlock(activeProfileId(), "x");
  renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
  expect(locked()).toBe("false");
  await openServiceView({ host: parseServicesHost("https://*.svc.ghostly.example")!, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "Demo", send: () => new Promise(() => {}), words });
});

afterEach(() => {
  closeServiceView();
  setServiceWindowsCloser(null);
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  delete (navigator as { userActivation?: unknown }).userActivation;
});

it("taps and keys in a contact's app keep the lock away while the person uses it; left alone, it locks and closes the app", async () => {
  // Two and a half minutes of use, past twice the lock time.
  for (let i = 0; i < 5; i++) {
    await awake(25_000);
    await tap();
  }
  expect(locked()).toBe("false");
  expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();

  await awake(MINUTE);
  expect(locked()).toBe("true");
  expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
});

it("an app on screen with nobody using it keeps nothing unlocked", async () => {
  await awake(MINUTE + 1_000);
  expect(locked()).toBe("true");
  expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
});
