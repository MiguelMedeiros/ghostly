import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors";
import { oneShotGroupJoinWait, oneShotJoinWait } from "../src/main";

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

  it("names the chat by its id when its label is one word a shell reads otherwise", async () => {
    // Found in a bug hunt: only a space sent the note to the id, so `--label "O'Brien"` read `chat wait O'Brien`, which
    // a shell holds for a closing quote, `$work` named no chat, and a backtick ran a command when pasted.
    const s = session(async () => { throw new CliError("timeout", "t"); });
    for (const label of ["O'Brien", "$work", "`id`", "a(b)", "bob&"]) {
      expect((await oneShotJoinWait(s, { chat: "c1" }, label)).note).toMatch(/ghostly chat wait c1 --until paired$/);
    }
  });

  it("says a paired chat paired, without a note", async () => {
    const s = session(async () => ({ id: "c1", stage: "live" }));
    expect(await oneShotJoinWait(s, { chat: "c1" })).toEqual({ answer: { chat: "c1", paired: true, stage: "live" } });
  });
});

describe("one-shot group join", () => {
  const views = (...list: unknown[]) => {
    let i = 0;
    return { call: async (method: string) => { if (method !== "group.get") throw new Error(method); const v = list[Math.min(i++, list.length - 1)]; if (v instanceof Error) throw v; return v; } };
  };
  const knocking = { status: "invited", invitation: { stage: "knocking" } };

  it("waits until a member's app lets it in, and says it is in", async () => {
    // Found in a bug hunt: it left at once with {"group": id} and exit 0, the knock ending with the command.
    const s = views(knocking, { status: "invited", invitation: { stage: "admitted" } }, { status: "active", invitation: null });
    expect(await oneShotGroupJoinWait(s, { group: "g1" }, 5, 1)).toEqual({ answer: { group: "g1", joined: true, stage: null } });
  });

  it("says it is not in yet and the next step once the wait is over", async () => {
    const { answer, note } = await oneShotGroupJoinWait(views(knocking), { group: "g-1_x" }, 0.02, 1);
    expect(answer).toEqual({ group: "g-1_x", joined: false, stage: "knocking" });
    expect(note).toBe("Not in yet: no member's app has let you in. A member's app lets you in only while this profile is running: keep it running (ghostly daemon --detach), then ghostly group show g-1_x");
  });

  it("stops at a stage waiting does not change, without the daemon's note", async () => {
    for (const stage of ["full", "blocked", "replaced"]) {
      expect(await oneShotGroupJoinWait(views({ status: "invited", invitation: { stage } }), { group: "g1" }, 5, 1)).toEqual({ answer: { group: "g1", joined: false, stage } });
    }
  });

  it("answers at once for a group it is already in", async () => {
    expect(await oneShotGroupJoinWait(views({ status: "active", invitation: null }), { group: "g1" }, 5, 1)).toEqual({ answer: { group: "g1", joined: true, stage: null } });
  });
});
