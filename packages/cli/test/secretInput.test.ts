import { describe, expect, it, vi } from "vitest";
import { secretsFromStdin, secretValuesWarning } from "../src/secretInput";
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

  it("wallet redeem with no token on a terminal is a usage error at once, not a silent wait on the keyboard", async () => {
    await expect(secretsFromStdin("wallet.redeem", {}, never, true)).rejects.toMatchObject({ code: "usage", message: expect.stringMatching(/\| ghostly wallet redeem/) });
    expect(await secretsFromStdin("wallet.redeem", { token: "cashuBabc" }, never, true)).toMatch(/shows in ps/);
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

  it("group join and invite join read the link or invite from stdin when none is given or -, and warn when it is an argument", async () => {
    for (const [method, param, command] of [["group.join", "link", "group join"], ["invite.join", "invite", "invite join"]] as const) {
      const params: Record<string, unknown> = {};
      expect(await secretsFromStdin(method, params, stdin("https://ghostly.example/#secret\n"))).toBeUndefined();
      expect(params).toEqual({ [param]: "https://ghostly.example/#secret" });
      const dash: Record<string, unknown> = { [param]: "-", label: "bob" };
      expect(await secretsFromStdin(method, dash, stdin("ghostly1abc"))).toBeUndefined();
      expect(dash).toEqual({ [param]: "ghostly1abc", label: "bob" });
      await expect(secretsFromStdin(method, {}, stdin(" \n"))).rejects.toMatchObject({ code: "usage" });
      await expect(secretsFromStdin(method, {}, never, true)).rejects.toMatchObject({ code: "usage", message: expect.stringContaining(`| ghostly ${command}`) });
      const onLine: Record<string, unknown> = { [param]: "ghostly1abc" };
      expect(await secretsFromStdin(method, onLine, never, true)).toMatch(/shows in ps/);
      expect(onLine).toEqual({ [param]: "ghostly1abc" });
    }
  });

  it("a join with no invite on a pipe nobody writes says so on stderr, then gives up with the usage error, not a silent wait for ever", async () => {
    vi.useFakeTimers();
    try {
      for (const [method, command] of [["group.join", "group join"], ["invite.join", "invite join"]] as const) {
        const notes: string[] = [];
        const silent = () => new Promise<string>(() => {});
        const join = secretsFromStdin(method, { label: "bob" }, silent, false, (text) => notes.push(text));
        const failed = expect(join).rejects.toMatchObject({ code: "usage", message: expect.stringContaining(`| ghostly ${command}`) });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(notes).toEqual([expect.stringContaining(`| ghostly ${command}`)]);
        await vi.advanceTimersByTimeAsync(60_000);
        await failed;
        expect(notes).toHaveLength(1);
      }
    } finally { vi.useRealTimers(); }
  });

  it("a join whose invite starts coming on stdin waits for all of it, and the piped form stays silent", async () => {
    vi.useFakeTimers();
    try {
      const notes: string[] = [];
      // A producer that writes at once but takes long to close stdin.
      const slow = (onData?: () => void) => { onData?.(); return new Promise<string>((resolve) => setTimeout(() => resolve("ghostly1abc\n"), 120_000)); };
      const params: Record<string, unknown> = {};
      const join = secretsFromStdin("invite.join", params, slow, false, (text) => notes.push(text));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await join).toBeUndefined();
      expect(params).toEqual({ invite: "ghostly1abc" });
      expect(notes).toEqual([]);
      // `-` asked for stdin: it waits as long as it takes, without a note.
      const dash: Record<string, unknown> = { invite: "-" };
      const late = () => new Promise<string>((resolve) => setTimeout(() => resolve("ghostly1def"), 120_000));
      const asked = secretsFromStdin("invite.join", dash, late, false, (text) => notes.push(text));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await asked).toBeUndefined();
      expect(dash).toEqual({ invite: "ghostly1def" });
      expect(notes).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("wallet create warns about a --value the source's form marks secret, not about its plain fields", () => {
    const list = { offers: [
      { type: "lightning", providers: [{ id: "nwc", fields: [{ name: "uri", kind: "secret" }] }, { id: "lnd", fields: [{ name: "url", kind: "text" }, { name: "macaroon", kind: "secret" }] }] },
      { type: "bitcoin", providers: [{ id: "bdk", fields: [{ name: "mnemonic", kind: "secret" }, { name: "scriptType", kind: "select" }] }] },
    ] };
    expect(secretValuesWarning(list, "lightning", "nwc", ["uri"])).toMatch(/--value uri on the command line shows in ps.*--stdin/);
    expect(secretValuesWarning(list, "lightning", "lnd", ["url", "macaroon"])).toMatch(/^--value macaroon on/);
    expect(secretValuesWarning(list, "lightning", "lnd", ["url"])).toBeUndefined();
    // On-chain is BDK unless another source is named.
    expect(secretValuesWarning(list, "bitcoin", undefined, ["mnemonic", "scriptType"])).toMatch(/^--value mnemonic on/);
    expect(secretValuesWarning(list, "lightning", "nwc", [])).toBeUndefined();
    expect(secretValuesWarning(undefined, "lightning", "nwc", ["uri"])).toBeUndefined();
  });

  it("other commands are left alone", async () => {
    const params = { chat: "x" };
    expect(await secretsFromStdin("chat.get", params, never)).toBeUndefined();
    expect(params).toEqual({ chat: "x" });
  });
});
