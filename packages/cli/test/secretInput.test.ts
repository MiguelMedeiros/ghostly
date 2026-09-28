import { describe, expect, it } from "vitest";
import { secretsFromStdin } from "../src/secretInput";
// covers: headless.cli

const stdin = (text: string) => async () => text;
const never = async (): Promise<string> => { throw new Error("stdin read"); };

describe("secrets from stdin, out of ps", () => {
  it("wallet redeem reads the token from stdin when none is given", async () => {
    const params: Record<string, unknown> = {};
    expect(await secretsFromStdin("wallet.redeem", params, stdin("cashuBabc\n"))).toBeUndefined();
    expect(params).toEqual({ token: "cashuBabc" });
    await expect(secretsFromStdin("wallet.redeem", {}, stdin("\n"))).rejects.toMatchObject({ code: "usage" });
  });

  it("a token on the command line still goes, with a warning, and stdin is not read", async () => {
    const params: Record<string, unknown> = { token: "cashuBabc" };
    expect(await secretsFromStdin("wallet.redeem", params, never)).toMatch(/shows in ps/);
    expect(params).toEqual({ token: "cashuBabc" });
  });

  it("wallet create --stdin takes name=value lines, api-key as the API key, beside --value", async () => {
    const params: Record<string, unknown> = { type: "lightning", values: { network: "signet" }, stdin: true };
    expect(await secretsFromStdin("wallet.create", params, stdin("uri=nostr+walletconnect://x?secret=y&a=b\napi-key=k=1\n\n"))).toBeUndefined();
    expect(params).toEqual({ type: "lightning", values: { network: "signet", uri: "nostr+walletconnect://x?secret=y&a=b" }, apiKey: "k=1" });
    await expect(secretsFromStdin("wallet.create", { stdin: true }, stdin("no equals sign"))).rejects.toMatchObject({ code: "usage" });
  });

  it("wallet create warns about an API key on the command line, not about plain fields", async () => {
    expect(await secretsFromStdin("wallet.create", { apiKey: "k" }, never)).toMatch(/shows in ps/);
    expect(await secretsFromStdin("wallet.create", { values: { network: "signet" } }, never)).toBeUndefined();
  });

  it("other commands are left alone", async () => {
    const params = { chat: "x" };
    expect(await secretsFromStdin("chat.get", params, never)).toBeUndefined();
    expect(params).toEqual({ chat: "x" });
  });
});
