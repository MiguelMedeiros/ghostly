import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors";
import { oneShotJoinWait } from "../src/main";

const session = (wait: () => Promise<unknown>, get: () => Promise<unknown> = async () => ({ stage: "waiting" })) => ({
  call: async (method: string) => method === "chat.wait" ? wait() : method === "chat.get" ? get() : Promise.reject(new Error(method)),
});

describe("one-shot invite join", () => {
  it("says the chat did not pair while the inviter is away, and the next step", async () => {
    const s = session(async () => { throw new CliError("timeout", "Timed out waiting for chat c1 to be paired"); });
    const { answer, note } = await oneShotJoinWait(s, { chat: "c1" }, "a");
    expect(answer).toEqual({ chat: "c1", paired: false, stage: "waiting" });
    expect(note).toBe("Not paired yet: the inviter's app is offline. It pairs when both are online: keep this profile running (ghostly daemon --detach), then ghostly chat wait a --until paired");
  });

  it("names the chat by its id when it has no label one can type as is", async () => {
    const s = session(async () => { throw new CliError("timeout", "t"); }, async () => { throw new Error("gone"); });
    expect(await oneShotJoinWait(s, { chat: "c1" }, "Bob Smith")).toMatchObject({ answer: { chat: "c1", paired: false, stage: null }, note: expect.stringMatching(/chat wait c1 --until paired$/) });
  });

  it("says a paired chat paired, without a note", async () => {
    const s = session(async () => ({ id: "c1", stage: "live" }));
    expect(await oneShotJoinWait(s, { chat: "c1" })).toEqual({ answer: { chat: "c1", paired: true, stage: "live" } });
  });
});
