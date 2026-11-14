import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { error, ghostly, home, localRelay, ok } from "./support/cli";
// covers: headless.cli

/**
 * `group:<ref>` names a group in every command. A chat's name given here could start with `group:`: `chat show` and
 * `chat history group:Crew` read that chat, while `send group:Crew` posted into the group Crew, so a bot that looked at
 * the chat answered in the group. Such a name is refused now, and a chat-only command reads `group:Crew` as the group.
 */
describe("group:<ref> is the group for every command", { timeout: 120_000 }, () => {
  const dir = home("group-ref-one-target");
  let relay: Awaited<ReturnType<typeof localRelay>>;
  let env: NodeJS.ProcessEnv;
  let chat: string, group: string;
  const as = (...args: string[]) => ghostly(["--home", dir, ...args], { env });

  beforeAll(async () => {
    relay = await localRelay();
    env = { GHOSTLY_PKARR_RELAYS: relay.url };
    chat = ok(await as("invite", "create", "--label", "bob")).chat as string;
    group = ok(await as("group", "create", "Crew", "--mesh")).group as string;
  });
  afterAll(() => relay?.server.close());

  it("refuses a chat's name that starts with group:", async () => {
    for (const name of ["group:Crew", "  group:Crew", `group:${group}`]) {
      expect(error(await as("chat", "rename", chat, name), "bad_request", 1).message).toContain('"group:"');
    }
    expect(error(await as("invite", "create", "--label", "group:Crew"), "bad_request", 1).message).toContain('"group:"');
    expect(ok(await as("chat", "show", chat))).toMatchObject({ name: "bob" });
    // A name with group: further in is a name like any other.
    ok(await as("chat", "rename", chat, "my group:Crew"));
    ok(await as("chat", "rename", chat, "bob"));
  });

  it("chat-only commands read group:Crew as the group, as send and group show do", async () => {
    expect(ok(await as("group", "show", "group:Crew"))).toMatchObject({ id: group });
    for (const args of [["chat", "show", "group:Crew"], ["chat", "history", "group:Crew"]]) {
      const refused = error(await as(...args), "not_found", 3);
      expect(refused.message, args.join(" ")).toContain("is a group");
    }
  });
});
