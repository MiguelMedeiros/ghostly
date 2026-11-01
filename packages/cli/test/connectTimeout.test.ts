import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { COMMANDS } from "../src/commands";
import { parseArgs } from "../src/args";
// covers: headless.chat

/** `chat connect` to a contact that is not there: `--timeout`, and a timeout that says what happens next. */
const link = { id: "chat-one", label: "bia", peerPubKeyZ32: "pchat-one", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", peerParticipationKey: "k",
  textDelivery: "stream", deliveryMode: "stream", pairing: { status: "connecting" } } as unknown as LinkView;

function fake(mode: "one-shot" | "daemon", connect: () => Promise<void>) {
  const node = { getState: () => ({ links: [link], groups: [], settings: {}, transport: {} }) as unknown as EngineState, connect: vi.fn(connect) };
  const ctx = { runtime: { server: { node }, paths: { name: "default", dir: "/nonexistent" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, emit: () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node };
}
const never = () => new Promise<void>(() => {});

afterEach(() => { vi.useRealTimers(); });

describe("chat connect", () => {
  it("takes --timeout, 1 to 90 s (the link's own wait)", () => {
    const command = COMMANDS["chat connect"]!;
    expect(command.usage).toBe("chat connect <chat> [--timeout s]");
    expect(command.params!(parseArgs(["chat", "connect", "bia", "--timeout", "5"], command.options), { chat: "bia" })).toEqual({ chat: "bia", timeout: 5 });
    expect(() => command.params!(parseArgs(["chat", "connect", "bia", "--timeout", "91"], command.options), { chat: "bia" })).toThrow(/timeout/);
  });

  it("gives up after --timeout, and says the one-shot's next step", async () => {
    vi.useFakeTimers();
    const { ctx } = fake("one-shot", never);
    const connect = callApi(ctx, "chat.connect", { chat: "bia", timeout: 5 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await connect).toMatchObject({
      code: "timeout", details: { chat: "chat-one" },
      message: "Timed out after 5 s: the contact did not answer. Try again later, or keep this profile online with `ghostly daemon --detach`: it reconnects by itself",
    });
  });

  it("the link's own timeout says the daemon goes on, with the wait that follows it", async () => {
    vi.useFakeTimers();
    const timedOut = Object.assign(new Error("Timed out connecting to the peer"), { code: "timeout" });
    const { ctx } = fake("daemon", () => new Promise<void>((_, reject) => { setTimeout(() => reject(timedOut), 89_000); }));
    const connect = callApi(ctx, "chat.connect", { chat: "bia" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(89_000);
    expect(await connect).toMatchObject({
      code: "timeout",
      message: "Timed out after 90 s: the contact did not answer. It reconnects by itself while this profile is online; ghostly chat wait bia --until live waits for it",
    });
  });

  it("answers as soon as the link is up, and keeps any other error", async () => {
    const { ctx } = fake("daemon", async () => {});
    expect(await callApi(ctx, "chat.connect", { chat: "bia", timeout: 5 })).toMatchObject({ id: "chat-one" });
    const unreachable = Object.assign(new Error("The contact is not reachable"), { code: "unreachable" });
    await expect(callApi(fake("daemon", async () => { throw unreachable; }).ctx, "chat.connect", { chat: "bia" })).rejects.toBe(unreachable);
  });
});
