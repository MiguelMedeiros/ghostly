import { afterEach, expect, it, vi } from "vitest";
import { createBroker, onScreen } from "../../lib/apps/broker";
import { memoryHost } from "../../lib/apps/memoryHost";
import { webLinkedFiles, type PickSheetText } from "../../lib/apps/webFiles";

// covers: apps.linked-files

/**
 * An app kept running in a chat that is not on screen (the person went to another chat) asks for a pick: WISP 1200
 * wants a click the person makes in the client, and the sheet would come up over the other chat, take the focus from
 * its message box and swallow what the person types there. The pick is refused until the app shows again.
 */
const text: PickSheetText = {
  ask: (app) => `${app} asks to read a folder`,
  choose: () => "Choose a folder",
  note: (app) => `Nothing is copied: ${app} reads what you pick.`,
  cancel: "Cancel",
  askAgain: (app, name) => `${app} asks to read “${name}” again`,
  allow: "Allow",
  notNow: "Not now",
};

afterEach(() => { document.body.replaceChildren(); });

it("a hidden app's pick is refused, with no sheet, while the person types elsewhere; shown again, it asks", async () => {
  // Chat A, kept loaded behind chat B, runs the app; chat B's message box has the focus.
  const chatA = document.body.appendChild(document.createElement("div"));
  // As App.tsx hides it (its class `hidden`).
  chatA.style.display = "none";
  const frame = chatA.appendChild(document.createElement("iframe"));
  const composer = document.body.appendChild(document.createElement("textarea"));
  composer.focus();

  let picked = 0;
  const host = { ...memoryHost(), linkedFiles: webLinkedFiles({ text: () => text, picker: async () => { picked++; return null; } }) };
  const posted: Record<string, unknown>[] = [];
  const broker = createBroker({
    host,
    launch: { ref: "pubkeyalpha/cinema", digest: "d", version: "1.0.0", title: "Cinema", permissions: ["files"], entry: "<p>app</p>", chat: { linkId: "link-a" } },
    view: { theme: () => "dark", locale: () => "en" },
    post: (message) => posted.push(message as Record<string, unknown>),
    stopped: () => {},
    shown: () => onScreen(frame),
  });
  broker.load();
  broker.message({ id: 0, type: "writing", args: [] });
  broker.load();
  const ask = async (id: number) => {
    broker.message({ id, type: "files.pick", args: [{ folder: true }] });
    await vi.waitFor(() => expect(posted.some((p) => p.id === id)).toBe(true));
    return posted.find((p) => p.id === id)!;
  };

  expect(onScreen(frame)).toBe(false);
  expect(await ask(1)).toMatchObject({ ok: false, error: "too-fast" });
  expect(document.querySelector("[data-testid=app-files-sheet]")).toBeNull();
  expect(document.activeElement).toBe(composer);
  expect(picked).toBe(0);

  // Back in chat A: the app shows, and its pick asks the person.
  chatA.style.display = "";
  expect(onScreen(frame)).toBe(true);
  void ask(2);
  await vi.waitFor(() => expect(document.querySelector("[data-testid=app-files-sheet]")).not.toBeNull());
});

it("a frame is not on screen out of the page, or in a tab that does not show", () => {
  const frame = document.createElement("iframe");
  expect(onScreen(frame)).toBe(false);
  document.body.appendChild(frame);
  expect(onScreen(frame)).toBe(true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  expect(onScreen(frame)).toBe(false);
  visibility.mockRestore();
});
