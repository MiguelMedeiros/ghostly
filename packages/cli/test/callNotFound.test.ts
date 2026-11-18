import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heardCallSignal } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { CallManager } from "../src/calls/manager";
// covers: headless.calls

/**
 * A call named by its id once it is no call any more (hung up twice, or a command racing the call's end) says it is no
 * call, not that no chat has that name. No media: the stack is missing, and the call only rings and is declined.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => { quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
afterEach(() => quiet.mockRestore());

/** A daemon's manager on fake chats: `links` are the chats it has. */
function managerWith(links: Partial<LinkView>[]): CallManager {
  const dir = mkdtempSync(join(tmpdir(), "gcnf-"));
  dirs.push(dir);
  const state = () => ({ links, groups: [], settings: { iceServers: [] } }) as unknown as EngineState;
  return new CallManager({
    engine: { getState: state, chatView: (id) => state().links.find((l) => l.id === id), getSettings: () => state().settings, setCallSignal: () => {} },
    emit: () => {}, profileDir: dir, stack: async () => "no media in this test",
  });
}

const chat = (id: string): Partial<LinkView> => ({ id, profile: "paired-chat/1", callsUnavailable: null, label: `to ${id}` });

/** The contact's call ringing in `chatId`: an offer as the engine hands it on. */
function ring(calls: CallManager, chatId: string): string {
  const offer = { t: "o", ts: Date.now(), u: "ufra", p: "p".repeat(22), f: "ab".repeat(32), s: "actpass", c: [], v: 0 };
  calls.onSignal(chatId, heardCallSignal(JSON.stringify(offer), Date.now()));
  const [call] = calls.list();
  return call.call as string;
}

describe("a call that is no call on now", () => {
  it("named by its id after it ended, says no call has that id (not_found), for hangup, get, flush and answer", async () => {
    const calls = managerWith([chat("chat-ba")]);
    const id = ring(calls, "chat-ba");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    await calls.hangup(id);
    const gone = { code: "not_found", message: `No call ${id}: it ended or never existed (ghostly call list)`, details: undefined };
    await expect(calls.hangup(id)).rejects.toMatchObject(gone);
    expect(() => calls.get(id)).toThrow(expect.objectContaining(gone));
    expect(() => calls.flush(id)).toThrow(expect.objectContaining(gone));
    await expect(calls.answer(id, {})).rejects.toMatchObject(gone);
    // An id no call ever had says the same.
    await expect(calls.hangup("0123456789ab")).rejects.toMatchObject({ code: "not_found", message: "No call 0123456789ab: it ended or never existed (ghostly call list)" });
    await calls.stopAll();
  });

  it("named by its chat, or by a ref that is no call's id, keeps the chat's words", async () => {
    const calls = managerWith([chat("chat-ba")]);
    await expect(calls.hangup("chat-ba")).rejects.toMatchObject({ code: "not_found", message: "No call in chat chat-ba" });
    await expect(calls.hangup("nobody")).rejects.toMatchObject({ code: "not_found", message: 'No chat "nobody" (ghostly chat list)' });
    // Not a call's id: upper case, or one character short.
    await expect(calls.hangup("0123456789AB")).rejects.toMatchObject({ message: 'No chat "0123456789AB" (ghostly chat list)' });
    await expect(calls.hangup("0123456789a")).rejects.toMatchObject({ message: 'No chat "0123456789a" (ghostly chat list)' });
    await calls.stopAll();
  });

  it("a chat whose id looks like a call's id is still found as that chat", async () => {
    const calls = managerWith([chat("0123456789ab")]);
    await expect(calls.hangup("0123456789ab")).rejects.toMatchObject({ code: "not_found", message: "No call in chat 0123456789ab" });
    const id = ring(calls, "0123456789ab");
    expect(calls.get("0123456789ab")).toMatchObject({ call: id, chat: "0123456789ab", state: "ringing" });
    await calls.hangup("0123456789ab");
    await calls.stopAll();
  });
});
