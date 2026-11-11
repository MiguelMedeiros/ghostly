import { afterEach, describe, expect, it, vi } from "vitest";
import { webLinkedFiles, type PickSheetText, type PickStore, type StoredPick } from "../../lib/apps/webFiles";

// covers: apps.linked-files

/**
 * Back (Android's back gesture, the browser's) with an app's files sheet up answers it as Cancel (or Not now) does,
 * as with every dialog and sheet: the page under it stays where it was. A file of its own: the open layers are the
 * module's, and a sheet another test leaves up would stay one.
 */
const text: PickSheetText = {
  ask: (app, folder) => `${app} asks to read ${folder ? "a folder" : "files"}`,
  choose: (folder) => (folder ? "Choose a folder" : "Choose files"),
  note: (app) => `Nothing is copied: ${app} reads what you pick.`,
  cancel: "Cancel",
  askAgain: (app, name) => `${app} asks to read “${name}” again`,
  allow: "Allow",
  notNow: "Not now",
};
const REF = "pubkeyalpha/cinema";
const CHATS = { usr: null, key: "k0", idx: 2 };
const CHAT = "#/chat/abc";
const ROUTER = { usr: null, key: "k1", idx: 3 };

const shown = (selector: string) => vi.waitFor(() => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
});
/** Waits for the history to settle: a traversal answers with a popstate, or nothing if there is none. */
const settled = () => new Promise<void>((resolve) => { const done = () => { removeEventListener("popstate", done); resolve(); }; addEventListener("popstate", done); setTimeout(done, 200); });
const back = async () => { const pop = settled(); history.back(); await pop; };

/** The chat list, then a chat: Back that leaves the chat lands on the list. */
const inChat = () => {
  history.pushState(CHATS, "", "#/chats");
  history.pushState(ROUTER, "", CHAT);
};

afterEach(async () => {
  await settled();
  document.body.replaceChildren();
});

describe("Back with an app's files sheet up", () => {
  it("answers it as Cancel does, leaves the chat under it where it was, and gives the focus back", async () => {
    inChat();
    const composer = document.body.appendChild(document.createElement("textarea"));
    composer.focus();
    let opened = 0;
    const pick = webLinkedFiles({ text: () => text, picker: async () => { opened++; return null; } }).pick(REF, "Cinema", { folder: true, accept: [] });
    await shown("[data-testid=app-files-sheet]");
    await settled();
    await back();
    expect(document.querySelector("[data-testid=app-files-sheet]")).toBeNull();
    await expect(pick).rejects.toThrow(/^cancelled: /);
    expect(opened).toBe(0);
    expect(location.hash).toBe(CHAT);
    expect(history.state).toEqual(ROUTER);
    expect(document.activeElement).toBe(composer);
  });

  it("the read-again sheet too: Back is Not now, the browser never asked", async () => {
    inChat();
    let asked = 0;
    const dir = { kind: "directory", name: "Films", queryPermission: async () => "prompt", requestPermission: async () => { asked++; return "granted"; } } as unknown as FileSystemDirectoryHandle;
    const kept: StoredPick = { ref: REF, id: "p1", keep: { dir }, entries: [{ id: "e1", path: "Films/Up.mp4", size: 10, modified: 9 }] };
    const store: PickStore = { all: async () => [kept], put: async () => {}, forget: async () => {}, remove: async () => {}, clear: async () => {} };
    const list = webLinkedFiles({ text: () => text, picker: async () => null, store }).list(REF, "Cinema");
    await shown("[data-testid=app-files-again]");
    await settled();
    await back();
    expect(document.querySelector("[data-testid=app-files-again]")).toBeNull();
    expect(await list).toMatchObject([{ id: "e1", available: false }]);
    expect(asked).toBe(0);
    expect(location.hash).toBe(CHAT);
    expect(history.state).toEqual(ROUTER);
  });

  it("Cancel then Back: the sheet's entry steps the page back once, to the list, not past it", async () => {
    inChat();
    const pick = webLinkedFiles({ text: () => text, picker: async () => null }).pick(REF, "Cinema", { folder: true, accept: [] });
    await shown("[data-testid=app-files-sheet]");
    await settled();
    (document.querySelector("[data-testid=app-files-cancel]") as HTMLButtonElement).click();
    await expect(pick).rejects.toThrow(/^cancelled: /);
    await settled();
    // The entry Cancel left is the page's: the person's next Back leaves the chat, as it would with no sheet ever up.
    await back();
    await settled();
    expect(location.hash).toBe("#/chats");
    expect(history.state).toEqual(CHATS);
  });
});
