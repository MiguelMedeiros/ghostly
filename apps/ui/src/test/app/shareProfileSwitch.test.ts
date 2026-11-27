import { afterEach, expect, it, vi } from "vitest";

// covers: app.android.share-target

/*
 * A share waiting in the Android app's Share to… picker when the person switches profile to send it from another one.
 * The switch restarts the page (`switchProfile`, lib/profiles.ts): each page here is fresh modules running main.tsx's
 * Android lines, against a host that does what Rust and Kotlin do. Rust's slot hands a share over once
 * (`incoming_share_take`); its tokens read until `incoming_share_done`, which also takes Kotlin's copy out of the
 * app's cache.
 */

type Page = {
  android: typeof import("../../desktop/android");
  share: typeof import("../../lib/incomingShare");
  profiles: typeof import("../../lib/profiles");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
  location.hash = "";
});

function androidHost() {
  let slot: unknown = null;
  const shelf = new Set<string>();
  const cache = new Set<string>();
  const taken: string[] = [];
  const handlers: (() => void)[] = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "incoming_share_take") {
      const share = slot;
      slot = null;
      taken.push(share ? "share" : "null");
      return share;
    }
    if (command === "incoming_share_done") {
      for (const token of args!.tokens as string[]) shelf.delete(token);
      if (!shelf.size) cache.clear();
      return;
    }
    if (command === "read_pasted_bytes") {
      if (!shelf.has(args!.token as string)) throw new Error("Nothing to read");
      return (args!.offset as number) < 3 ? [1, 2, 3] : [];
    }
    throw new Error(command);
  });
  /** A gallery shares one photo: Kotlin copies it, Rust holds it in its slot and tells the page. */
  const share = () => {
    cache.add("cache/shared/1");
    shelf.add("paste-1");
    slot = { title: "", text: "for Ana", files: [{ token: "paste-1", name: "IMG_1.jpg", size: 3, mime: "image/jpeg" }] };
    handlers.forEach((handler) => handler());
  };
  const startPage = async (): Promise<Page> => {
    vi.resetModules();
    handlers.length = 0;
    const page: Page = {
      android: await import("../../desktop/android"),
      share: await import("../../lib/incomingShare"),
      profiles: await import("../../lib/profiles"),
    };
    page.android.takeIncomingShares(invoke as never, async (_event, handler) => { handlers.push(handler); });
    return page;
  };
  /** Another share Rust holds in its slot and tells the page of (a notice: only names of files Android did not copy). */
  const shareNext = (next: unknown) => {
    slot = next;
    handlers.forEach((handler) => handler());
  };
  return { share, shareNext, startPage, taken, shelf, cache };
}

const names = (page: Page) => page.share.incomingShare()?.files.map((file) => file.name);

/** The person picks another profile: the switch's overlay frame, then the page restarts (here: it goes). */
function switchTo(page: Page, id: string) {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  page.profiles.switchProfile(id);
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(reload).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pagehide"));
}

it("a photo waiting in profile A's picker is in profile B's picker after the switch, and read there", async () => {
  const host = androidHost();
  const pageA = await host.startPage();
  host.share();
  await vi.waitFor(() => expect(names(pageA)).toEqual(["IMG_1.jpg"]));
  // The person leaves the picker for the profile switcher (the profile tab's long press, Settings).
  location.hash = "#/settings";
  const b = pageA.profiles.createProfile("B");

  switchTo(pageA, b.id);
  // The switch kept its copy: Rust's shelf still reads it.
  expect([...host.shelf]).toEqual(["paste-1"]);
  expect(location.hash).toBe("#/shared");

  const pageB = await host.startPage();
  await vi.waitFor(() => expect(host.taken).toEqual(["null", "share", "null"]));
  expect(names(pageB)).toEqual(["IMG_1.jpg"]);
  expect(pageB.share.incomingShare()?.text).toBe("for Ana");
  expect(location.hash).toBe("#/shared");

  // A chat of B takes it: the photo reads whole, then its copy leaves the app's cache.
  const [photo] = await pageB.share.shareFiles(pageB.share.incomingShare()!);
  expect([photo!.name, photo!.size]).toEqual(["IMG_1.jpg", 3]);
  expect([...host.shelf]).toEqual([]);
  expect([...host.cache]).toEqual([]);
});

it("the names a later share's notice added to the waiting photo are still said in profile B's picker after the switch", async () => {
  const host = androidHost();
  const pageA = await host.startPage();
  host.share();
  await vi.waitFor(() => expect(names(pageA)).toEqual(["IMG_1.jpg"]));
  // A second share brings only a video too large to bring in, a document Android could not read, one it had no room
  // for and one past the most a share brings: a notice, which joins the photo that waits.
  host.shareNext({ title: "", text: "", files: [], leftOut: ["VID_1.mp4"], unread: ["DOC_1.pdf"], noRoom: ["VID_2.mp4"], pastLimit: ["IMG_33.jpg"] });
  await vi.waitFor(() => expect(pageA.share.incomingShare()?.leftOut).toEqual(["VID_1.mp4"]));
  location.hash = "#/settings";
  const b = pageA.profiles.createProfile("B");

  switchTo(pageA, b.id);

  const pageB = await host.startPage();
  await vi.waitFor(() => expect(names(pageB)).toEqual(["IMG_1.jpg"]));
  const kept = pageB.share.incomingShare()!;
  expect([kept.leftOut, kept.unread, kept.noRoom, kept.pastLimit]).toEqual([["VID_1.mp4"], ["DOC_1.pdf"], ["VID_2.mp4"], ["IMG_33.jpg"]]);
  expect(kept.text).toBe("for Ana");
});

it("a file over the paste total is named once in profile B's picker, with a notice's names, after the switch", async () => {
  const host = androidHost();
  const pageA = await host.startPage();
  const { PLATFORM_PASTE_MAX } = await import("../../lib/pastedFiles");
  host.shelf.add("paste-1");
  host.shelf.add("paste-2");
  // A photo and a video that together pass what a paste brings in: the page leaves the video out, and names it.
  host.shareNext({
    title: "",
    text: "",
    files: [
      { token: "paste-1", name: "IMG_1.jpg", size: 3, mime: "image/jpeg" },
      { token: "paste-2", name: "VID_9.mp4", size: PLATFORM_PASTE_MAX, mime: "video/mp4" },
    ],
  });
  await vi.waitFor(() => expect(pageA.share.incomingShare()?.leftOut).toEqual(["VID_9.mp4"]));
  host.shareNext({ title: "", text: "", files: [], leftOut: ["VID_1.mp4"] });
  await vi.waitFor(() => expect(pageA.share.incomingShare()?.leftOut).toEqual(["VID_9.mp4", "VID_1.mp4"]));
  location.hash = "#/settings";
  const b = pageA.profiles.createProfile("B");

  switchTo(pageA, b.id);

  const pageB = await host.startPage();
  await vi.waitFor(() => expect(names(pageB)).toEqual(["IMG_1.jpg"]));
  expect([...pageB.share.incomingShare()!.leftOut!].sort()).toEqual(["VID_1.mp4", "VID_9.mp4"]);
});

it("a share the page never read goes with the page, its copy out of the app's cache with it", async () => {
  const host = androidHost();
  const page = await host.startPage();
  host.share();
  await vi.waitFor(() => expect(names(page)).toEqual(["IMG_1.jpg"]));
  expect([...host.cache]).toEqual(["cache/shared/1"]);

  // The page goes without keeping it (a reload, the app closing).
  window.dispatchEvent(new Event("pagehide"));
  await vi.waitFor(() => expect([...host.cache]).toEqual([]));
  expect([...host.shelf]).toEqual([]);

  // Nothing waits for the next page.
  const next = await host.startPage();
  await vi.waitFor(() => expect(host.taken).toEqual(["null", "share", "null"]));
  expect(next.share.incomingShare()).toBeNull();
});

it("a switch with nothing waiting opens the profile where it was, and keeps nothing", async () => {
  const host = androidHost();
  const page = await host.startPage();
  const b = page.profiles.createProfile("B");
  switchTo(page, b.id);
  expect(location.hash).toBe("#/");
  expect(sessionStorage.getItem("ghostly_carried_share")).toBeNull();
});
