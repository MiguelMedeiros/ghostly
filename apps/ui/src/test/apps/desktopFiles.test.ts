import { describe, expect, it } from "vitest";
import { desktopLinkedFiles } from "../../lib/apps/desktopFiles";

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
