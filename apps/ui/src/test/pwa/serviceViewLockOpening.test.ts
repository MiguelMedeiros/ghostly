import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { closeServiceWindows, setServiceWindowsCloser } from "../../lib/serviceWindows";
import { openServiceView } from "../../../../web/src/svc/opener";
import { SERVICE_VIEW_ID, closeServiceView, parseServicesHost } from "../../../../web/src/svc/protocol";

/**
 * The profile locking while a contact's app is still on its way (its address worked out, before it is drawn) closes
 * nothing yet: the app is never drawn, so nothing behind the lock answers it, and the lock screen stays usable.
 */
const words = { unreachable: "", failed: "", close: "Close", callOn: "", tooSlow: "", offline: "", retry: "", label: "Demo", owner: "Not Ghostly", hostError: () => null };
const open = () => openServiceView({ host: parseServicesHost("https://*.svc.ghostly.example")!, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "Demo", send: () => new Promise(() => {}), words });

beforeAll(() => {
  // happy-dom would load the bridge page from the network: nothing here needs it.
  const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
  if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
});

let root: HTMLElement;
beforeEach(() => {
  // The web host's: the lock closes the view (apps/web/src/host.ts).
  setServiceWindowsCloser(closeServiceView);
  root = document.createElement("div");
  root.id = "root";
  root.append(document.createElement("dialog"));
  document.body.append(root);
});

afterEach(() => {
  closeServiceView();
  setServiceWindowsCloser(null);
  root.remove();
});

it("a lock while the app opens draws nothing and leaves the lock screen usable", async () => {
  const opening = open();
  closeServiceWindows();
  await expect(opening).rejects.toThrow();
  expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  expect(root.hasAttribute("inert")).toBe(false);
});

it("with no lock it opens, and a later lock closes it", async () => {
  await open();
  expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();
  expect(root.hasAttribute("inert")).toBe(true);
  closeServiceWindows();
  expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  expect(root.hasAttribute("inert")).toBe(false);
});
