import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors";
import { oneShotJoinWait } from "../src/main";

const session = (wait: () => Promise<unknown>, get: (params: { chat: string }) => Promise<unknown> = async () => ({ id: "c1", stage: "waiting" })) => ({
  call: async (method: string, params?: unknown) => method === "chat.wait" ? wait() : method === "chat.get" ? get(params as { chat: string }) : Promise.reject(new Error(method)),
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

  it("names the chat by its id when its label is one word a shell reads otherwise", async () => {
    // Found in a bug hunt: only a space sent the note to the id, so `--label "O'Brien"` read `chat wait O'Brien`, which
    // a shell holds for a closing quote, `$work` named no chat, and a backtick ran a command when pasted.
    const s = session(async () => { throw new CliError("timeout", "t"); });
    for (const label of ["O'Brien", "$work", "`id`", "a(b)", "bob&"]) {
      expect((await oneShotJoinWait(s, { chat: "c1" }, label)).note).toMatch(/ghostly chat wait c1 --until paired$/);
    }
  });

  it("names the chat by its id when its label names another chat too", async () => {
    // Found in a bug hunt: a second join with the same `--label alice` (a new invite after one that never paired) was
    // told `chat wait alice --until paired`, which answered that "alice" names more than one chat.
    const s = session(async () => { throw new CliError("timeout", "t"); }, async ({ chat }) => {
      if (chat === "c2") return { id: "c2", stage: "failed" };
      throw new CliError("bad_request", `${JSON.stringify(chat)} names more than one chat: use its id`);
    });
    expect((await oneShotJoinWait(s, { chat: "c2" }, "alice")).note).toMatch(/ghostly chat wait c2 --until paired$/);
  });

  it("says a paired chat paired, without a note", async () => {
    const s = session(async () => ({ id: "c1", stage: "live" }));
    expect(await oneShotJoinWait(s, { chat: "c1" })).toEqual({ answer: { chat: "c1", paired: true, stage: "live" } });
  });
});
