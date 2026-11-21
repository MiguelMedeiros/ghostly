import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { findGroup } from "../src/apiKit";
import { main } from "../src/main";
import { home } from "./support/cli";
import { chatViewOf } from "./support/chatView";
// covers: headless.cli, chat.saved

/** A ref that names nothing is said the same way on a profile, a chat or a group: quoted as given, with where to look. */
describe("not-found words", () => {
  it("`profile use` and `--profile` say the same about a profile that does not exist, with how to list or make one", async () => {
    const dir = home("no-such-profile-words");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const said = { code: "not_found", message: 'No profile "nosuch" (ghostly profile list, or ghostly profile create nosuch)' };
      await expect(main(["--home", dir, "profile", "use", "nosuch"])).rejects.toMatchObject(said);
      await expect(main(["--home", dir, "--profile", "nosuch", "status"])).rejects.toMatchObject(said);
    } finally { write.mockRestore(); }
  });

  it("a group: ref is echoed as given", () => {
    const one = { id: "k86qoxaaaaaaaaaaaaaaaa", name: "One", status: "active" } as unknown as GroupView;
    const two = { id: "k86qzzaaaaaaaaaaaaaaaa", name: "Two", status: "active" } as unknown as GroupView;
    expect(() => findGroup([one, two], "group:")).toThrow(expect.objectContaining({ code: "bad_request", message: '"group:" names no group' }));
    expect(() => findGroup([one, two], "group:k86q")).toThrow(expect.objectContaining({ code: "bad_request", message: '"group:k86q" names more than one group: use its id' }));
    expect(() => findGroup([one, two], "group:zed")).toThrow(expect.objectContaining({ code: "not_found", message: 'No group "group:zed" (ghostly group list)' }));
  });

  it("saved add and remove say group on a group, as pin and message details do", async () => {
    const node = {
      chatView: chatViewOf, getState: () => ({ links: [{ id: "chat-one", label: "Alice", peerNick: "Alice", pairing: { status: "ready" } } as unknown as LinkView], groups: [{ id: "g1", name: "Crew", status: "active" }], settings: {}, transport: {} }) as unknown as EngineState,
      saveMessage: vi.fn(async () => ({ error: "That message is not in this chat" })),
    };
    const ctx = { runtime: { server: { node } }, mode: "daemon" } as unknown as ApiContext;
    await expect(callApi(ctx, "saved.add", { chat: "group:g1", message: "abc" })).rejects.toMatchObject({ code: "not_found", message: 'No message "abc" in this group (ghostly group history group:g1)' });
    await expect(callApi(ctx, "saved.add", { chat: "Alice", message: "abc" })).rejects.toMatchObject({ code: "not_found", message: 'No message "abc" in this chat (ghostly chat history Alice)' });
    await expect(callApi(ctx, "saved.remove", { chat: "Crew", message: "abc" })).rejects.toMatchObject({ code: "not_found", message: 'No saved message "abc" in this group (ghostly saved list shows the saved ones)' });
  });
});
