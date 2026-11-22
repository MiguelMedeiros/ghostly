import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { enrollDevice, moveDevice } from "@ghostly/browser/devices/store";
import { listenForShares } from "../../../../web/src/pwa/serviceWorker";
import { clearAllData } from "../../lib/clearData";
import { incomingShare, peekShareFor, resetIncomingShare, sendShareTo } from "../../lib/incomingShare";
import { profileDatabase, removeProfileHere } from "../../lib/profileData";
import { activeProfileId } from "../../lib/profiles";

// covers: app.clear-data, app.pwa.share-target

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/** The page's worker: what the page posts to it. */
class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  postMessage(message: unknown) { this.posted.push(message); }
}

class FakeContainer extends EventTarget {
  controller = new FakeWorker();
  get ready() { return Promise.resolve({ active: this.controller }); }
  startMessages() {}
}

let container: FakeContainer;

beforeEach(() => {
  container = new FakeContainer();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
  resetIncomingShare();
  window.location.hash = "";
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(window, "isSecureContext");
  window.location.hash = "";
  resetIncomingShare();
  vi.restoreAllMocks();
});

/** A share sent to chat1 with a file, and one still in the picker: what the page holds when the profile goes. */
function sharesWaiting(): void {
  listenForShares();
  const items = [
    { title: "", text: "sent to a chat", url: "", files: [new File(["%PDF"], "scan.pdf", { type: "application/pdf" })] },
    { title: "", text: "still in the picker", url: "", files: [] },
  ];
  for (const item of items) container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item } }));
  sendShareTo("chat1");
  expect(incomingShare()).toMatchObject({ text: "still in the picker" });
  expect(peekShareFor("chat1")).toMatchObject({ text: "sent to a chat" });
}

const kept = () => container.controller.posted.filter((message) => (message as { type: string }).type === "share-keep");

describe("the shares a page holds when its profile's data goes", () => {
  it("Clear all data drops them: the reload after it hands none to the worker for the next page", async () => {
    sharesWaiting();
    await clearAllData();
    window.dispatchEvent(new Event("pagehide"));
    expect(kept()).toEqual([]);
    expect(incomingShare()).toBeNull();
    expect(peekShareFor("chat1")).toBeNull();
  });

  it("Remove this profile here drops them too", async () => {
    await enrollDevice(profileDatabase(activeProfileId()), "active");
    await moveDevice(profileDatabase(activeProfileId()), "removed");
    sharesWaiting();
    await removeProfileHere();
    window.dispatchEvent(new Event("pagehide"));
    expect(kept()).toEqual([]);
  });

  it("a page that goes for another reason (a profile switch) still carries them", () => {
    sharesWaiting();
    window.dispatchEvent(new Event("pagehide"));
    expect(kept()).toHaveLength(2);
  });
});
