import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CliError } from "../src/errors";
import { chatViewOf } from "./support/chatView";
// covers: headless.chat

/**
 * `chat verify <chat> --code <code>`: the code `chat show` prints as `comparisonCode` (six groups of four, spaces
 * between), as the contact reads it out or writes it. The right code written with hyphens or colons between its groups
 * (`ab12-cd34-...`) was refused as "does not match: do not trust this chat", and so was one typed short: the
 * warning of an attack for a slip of typing. Its separators are now nothing, and a code of another length says so.
 */
const CODE = "ab12 cd34 ef56 0789 aa11 bb22";
const bob = { id: "chat-bob", label: "Bob", peerPubKeyZ32: "pbob", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", pairing: { status: "ready", code: CODE } } as unknown as LinkView;

function fake() {
  const confirmPair = vi.fn(async () => {});
  const node = { chatView: chatViewOf, getState: () => ({ links: [bob], groups: [], settings: {}, transport: {} }) as unknown as EngineState, confirmPair };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, confirmPair };
}

const verify = (ctx: ApiContext, code: string) => callApi(ctx, "chat.verify", { chat: "Bob", code });
const refusal = (ctx: ApiContext, code: string) => verify(ctx, code).then(() => null, (e: unknown) => e) as Promise<CliError>;

describe("chat verify --code", () => {
  it.each([
    ["spaces", CODE],
    ["hyphens", CODE.replace(/ /g, "-")],
    ["colons", CODE.replace(/ /g, ":")],
    ["dots", CODE.replace(/ /g, ".")],
    ["nothing between, upper case", CODE.replace(/ /g, "").toUpperCase()],
  ])("takes the right code written with %s between its groups", async (_, code) => {
    const { ctx, confirmPair } = fake();
    await verify(ctx, code);
    expect(confirmPair).toHaveBeenCalledWith({ linkId: "chat-bob", code: CODE });
  });

  it("says a code typed short is not the whole code, not that the chat is not to be trusted", async () => {
    const { ctx, confirmPair } = fake();
    const error = await refusal(ctx, "ab12 cd34 ef56 0789 aa11");
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("bad_request");
    expect(error.message).toBe("The code given has 20 characters, and the one this chat shows has 24 (6 groups, as chat show prints comparisonCode): check it was typed whole");
    expect(error.message).not.toMatch(/trust/);
    expect(confirmPair).not.toHaveBeenCalled();
  });

  it("still warns when a whole code differs", async () => {
    const { ctx, confirmPair } = fake();
    const error = await refusal(ctx, "ab12 cd34 ef56 0789 aa11 bb23");
    expect(error.code).toBe("refused");
    expect(error.message).toMatch(/do not trust this chat/);
    expect(confirmPair).not.toHaveBeenCalled();
  });
});
