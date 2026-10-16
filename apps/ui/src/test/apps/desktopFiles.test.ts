import { describe, expect, it, vi } from "vitest";
import type { MiniAppLinkedFile } from "@ghostly/core/miniApp";
import { PICK_AFTER_CANCEL_MS } from "../../lib/apps/broker";
import { desktopLinkedFiles } from "../../lib/apps/desktopFiles";
import { APP_CLOSED_EVENT, APP_REQUEST_EVENT, desktopOpener } from "../../lib/apps/desktopOpener";
import { memoryHost } from "../../lib/apps/memoryHost";

// covers: apps.linked-files

/** Linked files on Desktop: the host's commands, with the profile's space, and its refusals as errors the broker reads. */
describe("desktop linked files", () => {
  it("names the host's commands with the space, the app and the dialog's title", async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const answers: Record<string, unknown> = {
      linked_files_pick: [{ id: "a".repeat(22), path: "Films/Up.mp4", size: 3, modified: 1, available: true }],
      linked_files_list: [],
      linked_files_read: new Uint8Array([1, 2, 3]).buffer,
      linked_files_forget: undefined,
    };
    const invoke = async <T,>(command: string, args?: Record<string, unknown>) => { calls.push([command, args]); return answers[command] as T; };
    const host = desktopLinkedFiles(invoke, () => "ghostly_ab", (app, folder) => `${app} asks to read ${folder ? "a folder" : "files"}`);
    expect(await host.pick("key/cinema", "Cinema", { folder: true, accept: ["mp4"] })).toHaveLength(1);
    expect(await host.read("key/cinema", "a".repeat(22), 5, 10)).toEqual(new Uint8Array([1, 2, 3]));
    await host.list("key/cinema", "Cinema");
    await host.forget("key/cinema", "all");
    expect(calls).toEqual([
      ["linked_files_pick", { space: "ghostly_ab", appRef: "key/cinema", title: "Cinema asks to read a folder", folder: true, accept: ["mp4"] }],
      ["linked_files_read", { space: "ghostly_ab", appRef: "key/cinema", id: "a".repeat(22), offset: 5, length: 10 }],
      ["linked_files_list", { space: "ghostly_ab", appRef: "key/cinema" }],
      ["linked_files_forget", { space: "ghostly_ab", appRef: "key/cinema", id: "all" }],
    ]);
  });

  it("passes the host's refusals on as errors", async () => {
    const host = desktopLinkedFiles(async () => { throw "cancelled: Nothing was picked"; }, () => "ghostly", () => "");
    await expect(host.pick("key/cinema", "Cinema", { folder: true, accept: [] })).rejects.toThrow(/^cancelled: /);
  });
});

const REF = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u/cinema";

/**
 * Desktop opens a window, with a broker of its own, for every `openApp`: the real opener, broker and host, with Rust
 * played. Each `linked_files_pick` is a system dialog held open until the test answers it; `linked_files_pick_cancel`
 * makes the pick in flight keep nothing, as Rust's `begin`/`add` do.
 */
function desktop() {
  const host = memoryHost("ghostly-app://localhost/", "ghostly-app://localhost/");
  host.entry = async (ref) => ({ ref, digest: "d", version: "1.0.0", title: "Cinema", permissions: ["files"], entry: "<p>cinema</p>" });
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const dialogs: { answer(picked: MiniAppLinkedFile[] | null): void; done: boolean }[] = [];
  const kept: MiniAppLinkedFile[] = [];
  let cleared = 0;
  let clock = 1_000;
  let labels = 0;
  const invoke = (async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "app_open") return `app-${++labels}`;
    if (command === "linked_files_pick_cancel") { cleared++; return undefined; }
    if (command === "linked_files_pick") {
      const begun = cleared;
      return new Promise<MiniAppLinkedFile[]>((resolve, reject) => {
        const dialog = {
          done: false,
          answer: (picked: MiniAppLinkedFile[] | null) => {
            dialog.done = true;
            if (picked === null) reject("cancelled: Nothing was picked");
            else if (cleared !== begun) reject("cancelled: The app's files were let go while it picked");
            else { kept.push(...picked); resolve(picked); }
          },
        };
        dialogs.push(dialog);
      });
    }
    if (command === "linked_files_list") return kept;
    return undefined;
  }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  const listen = async <T,>(event: string, handler: (event: { payload: T }) => void) => { handlers.set(event, handler as (event: { payload: unknown }) => void); return () => {}; };
  const linkedFiles = desktopLinkedFiles(invoke, () => "ghostly_ab", (app, folder) => `${app} asks to read ${folder ? "a folder" : "files"}`, () => clock);
  const open = desktopOpener({ apps: () => host, invoke, listen, nameIn: () => undefined, view: { theme: () => "dark", locale: () => "en" }, startTimeoutMs: 60_000, linkedFiles });
  const request = (label: string, message: unknown) => handlers.get(APP_REQUEST_EVENT)!({ payload: { label, request: message } });
  const posts = (label: string) => calls.filter((c) => c.command === "app_post" && c.args.label === label).map((c) => c.args.message as Record<string, unknown>);
  const answer = async (label: string, id: number) => {
    await vi.waitFor(() => expect(posts(label).some((m) => m.id === id)).toBe(true));
    return posts(label).find((m) => m.id === id)!;
  };
  const run = async (label: string) => {
    request(label, { id: 0, type: "writing", args: [] });
    await answer(label, 0);
  };
  const openDialogs = () => dialogs.filter((d) => !d.done).length;
  const closed = (label: string) => handlers.get(APP_CLOSED_EVENT)!({ payload: label });
  const pass = (ms: number) => { clock += ms; };
  return { open, request, answer, run, dialogs, openDialogs, closed, kept, calls, pass };
}

describe("desktop files.pick, one app in two windows", () => {
  it("one dialog at a time per app: the second window's pick is refused while the first waits on the person", async () => {
    const { open, run, request, answer, openDialogs, dialogs } = desktop();
    await open(REF, "link-ana");
    await open(REF, "link-bob");
    await run("app-1");
    await run("app-2");
    request("app-1", { id: 1, type: "files.pick", args: [{ folder: true }] });
    await vi.waitFor(() => expect(openDialogs()).toBe(1));
    request("app-2", { id: 1, type: "files.pick", args: [{ folder: true }] });
    expect(await answer("app-2", 1)).toMatchObject({ ok: false, error: "too-fast" });
    expect(openDialogs()).toBe(1);
    // Once the person answered, either window may ask again.
    dialogs[0]!.answer([]);
    await answer("app-1", 1);
    request("app-2", { id: 2, type: "files.pick", args: [{ folder: true }] });
    await vi.waitFor(() => expect(openDialogs()).toBe(1));
  });

  it("after the person cancels, the app waits PICK_AFTER_CANCEL_MS from any of its windows", async () => {
    const { open, run, request, answer, dialogs, openDialogs, pass } = desktop();
    await open(REF, "link-ana");
    await open(REF, "link-bob");
    await run("app-1");
    await run("app-2");
    request("app-1", { id: 1, type: "files.pick", args: [{ folder: true }] });
    await vi.waitFor(() => expect(openDialogs()).toBe(1));
    dialogs[0]!.answer(null);
    expect(await answer("app-1", 1)).toMatchObject({ ok: false, error: "cancelled" });
    request("app-2", { id: 1, type: "files.pick", args: [{ folder: true }] });
    expect(await answer("app-2", 1)).toMatchObject({ ok: false, error: "too-fast" });
    pass(PICK_AFTER_CANCEL_MS);
    request("app-2", { id: 2, type: "files.pick", args: [{ folder: true }] });
    await vi.waitFor(() => expect(openDialogs()).toBe(1));
    expect(dialogs).toHaveLength(2);
  });
});

describe("desktop files.pick when the app stops", () => {
  it("the dialog of an app whose window closed keeps nothing, and the app reopened cannot open a second one meanwhile", async () => {
    const { open, run, request, answer, dialogs, openDialogs, closed, kept, calls } = desktop();
    await open(REF, "link-ana");
    await run("app-1");
    request("app-1", { id: 1, type: "files.pick", args: [{ folder: true }] });
    await vi.waitFor(() => expect(openDialogs()).toBe(1));
    // The person closes the app's window; the system dialog cannot be taken back and stays on screen.
    closed("app-1");
    await vi.waitFor(() => expect(calls.filter((c) => c.command === "linked_files_pick_cancel")).toEqual([
      { command: "linked_files_pick_cancel", args: { space: "ghostly_ab", appRef: REF } },
    ]));
    await open(REF, "link-ana");
    await run("app-2");
    request("app-2", { id: 1, type: "files.pick", args: [{ folder: true }] });
    expect(await answer("app-2", 1)).toMatchObject({ ok: false, error: "too-fast" });
    expect(openDialogs()).toBe(1);
    // They answer the first dialog, whose app is gone: nothing is kept, and the reopened app may pick again.
    dialogs[0]!.answer([{ id: "a".repeat(22), path: "Documents/taxes-2025.pdf", size: 411, modified: 1, available: true }]);
    request("app-2", { id: 2, type: "files.list", args: [] });
    expect((await answer("app-2", 2)).value).toEqual([]);
    expect(kept).toEqual([]);
    request("app-2", { id: 3, type: "files.pick", args: [{ folder: true }] });
    await vi.waitFor(() => expect(openDialogs()).toBe(1));
  });
});
