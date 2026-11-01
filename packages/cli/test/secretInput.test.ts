import { describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors";
import { completeWithPipedEvidence, identityFields, identitySecretFields, secretsFromStdin, secretValuesWarning, textFromStdin } from "../src/secretInput";
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

  it("wallet redeem - reads the token from stdin, without the warning that it was on the command line", async () => {
    const params: Record<string, unknown> = { token: "-" };
    expect(await secretsFromStdin("wallet.redeem", params, stdin("cashuBabc\n"))).toBeUndefined();
    expect(params).toEqual({ token: "cashuBabc" });
    await expect(secretsFromStdin("wallet.redeem", { token: "-" }, stdin(" \n"))).rejects.toMatchObject({ code: "usage" });
    await expect(secretsFromStdin("wallet.redeem", { token: "-" }, never, true)).rejects.toMatchObject({ code: "usage", message: expect.stringMatching(/\| ghostly wallet redeem/) });
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

  it("wallet redeem with no token on a pipe nobody writes says so on stderr, then gives up with the usage error", async () => {
    vi.useFakeTimers();
    try {
      const notes: string[] = [];
      const redeem = secretsFromStdin("wallet.redeem", {}, () => new Promise<string>(() => {}), false, (text) => notes.push(text));
      const failed = expect(redeem).rejects.toMatchObject({ code: "usage", message: expect.stringMatching(/^Missing <cashu-token>: nothing came on stdin in 60 s.*\| ghostly wallet redeem/) });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(notes).toEqual([expect.stringContaining("| ghostly wallet redeem")]);
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
      expect(notes).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("send and edit with no text on a pipe nobody writes say so on stderr, then give up with the usage error; --stdin waits", async () => {
    vi.useFakeTimers();
    try {
      for (const command of ["send bob", "edit bob m1", "group send team", "group edit team m1"]) {
        const notes: string[] = [];
        const text = textFromStdin(() => new Promise<string>(() => {}), command, false, (note) => notes.push(note));
        const failed = expect(text).rejects.toMatchObject({ code: "usage", message: expect.stringMatching(new RegExp(`^No text: nothing came on stdin in 60 s.*\\| ghostly ${command}\\)`)) });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(notes).toEqual([`Waiting for the text on stdin (… | ghostly ${command}): give it there or as arguments`]);
        await vi.advanceTimersByTimeAsync(60_000);
        await failed;
        expect(notes).toHaveLength(1);
      }
      // Text that starts coming is waited for to its end, without a note; the last newline is not part of it.
      const notes: string[] = [];
      const slow = (onData?: () => void) => { onData?.(); return new Promise<string>((resolve) => setTimeout(() => resolve("hello\n\n"), 120_000)); };
      const sent = textFromStdin(slow, "send bob", false, (note) => notes.push(note));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await sent).toBe("hello\n");
      // --stdin asked for it: as long as it takes.
      const asked = textFromStdin(() => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 120_000)), "send bob", true, (note) => notes.push(note));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await asked).toBe("late");
      expect(notes).toEqual([]);
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

  it("identity add --stdin takes a signer's fields as name=value lines, out of ps; a --field the signer marks secret is warned about", async () => {
    const link = "bunker://abc?relay=wss://r.example&secret=s3cr=t";
    const piped = await identityFields(["domain=example.com"], true, ["bunker"], stdin(`bunker=${link}\n\n`));
    expect(piped).toEqual({ fields: { domain: "example.com", bunker: link } });
    const onLine = await identityFields([`bunker=${link}`, "domain=example.com"], false, ["bunker"], never);
    expect(onLine.fields).toEqual({ bunker: link, domain: "example.com" });
    expect(onLine.warning).toMatch(/^--field bunker on the command line shows in ps.*--stdin/);
    expect(onLine.warning).not.toContain(link);
    expect((await identityFields(["domain=example.com"], false, ["bunker"], never)).warning).toBeUndefined();
    // A terminal would wait on the keyboard without a word.
    await expect(identityFields([], true, ["bunker"], never, true)).rejects.toMatchObject({ code: "usage", message: expect.stringMatching(/\| ghostly identity add <provider> --signer id --stdin/) });
  });

  it("identity add's usage errors for a field with no = never repeat the value", async () => {
    // `--field bunker://…` with the name left out, and `--field =bunker://…`.
    for (const item of ["bunker://abc@s3cret", "=bunker://abc?secret=s3cret"]) {
      const error = await identityFields([item], false, [], never).catch((e: CliError) => e);
      expect(error).toMatchObject({ code: "usage" });
      expect((error as CliError).message).not.toContain("s3cret");
    }
    const error = await identityFields([], true, [], stdin("bunker://abc@s3cret\n")).catch((e: CliError) => e);
    expect(error).toMatchObject({ code: "usage" });
    expect((error as CliError).message).not.toContain("s3cret");
  });

  it("the secret fields of identity add are its signers' kind: secret ones, as the providers mark them", async () => {
    const { IDENTITY_PROVIDERS } = await import("@ghostly/browser/proofs/registry");
    const nostr = IDENTITY_PROVIDERS.find((p) => p.id === "nostr"), domain = IDENTITY_PROVIDERS.find((p) => p.id === "domain");
    expect(identitySecretFields(nostr, "nip46")).toEqual(["bunker"]);
    expect(identitySecretFields(nostr)).toEqual(["bunker"]);
    expect(identitySecretFields(nostr, "nip07")).toEqual([]);
    expect(identitySecretFields(domain, "nip05-nip46")).toEqual(["bunker"]);
    expect(identitySecretFields(undefined)).toEqual([]);
  });

  // `ssh-keygen … | ghostly identity complete <draft>` left the pipe unread and said "evidence is required".
  it("identity complete reads a tool's output piped to it once the draft asks for one, and never for a published record", async () => {
    const needs = new CliError("usage", "Missing what ssh-keygen printed", { needs: "evidence" });
    const tool = vi.fn(async (p: Record<string, unknown>) => { if (p.evidence === undefined) throw needs; return { done: true, evidence: p.evidence }; });
    expect(await completeWithPipedEvidence(tool, { draft: "d1" }, stdin("-----BEGIN SSH SIGNATURE-----\n"), () => {})).toEqual({ done: true, evidence: "-----BEGIN SSH SIGNATURE-----\n" });
    expect(tool).toHaveBeenCalledTimes(2);
    // A published record is done on the first ask: the pipe, maybe one nobody closes, is not read.
    expect(await completeWithPipedEvidence(async () => ({ done: true }), { draft: "d2" }, never, () => {})).toEqual({ done: true });
    // Another refusal is the draft's own, as it was.
    await expect(completeWithPipedEvidence(async () => { throw new CliError("not_found", "No such draft here"); }, { draft: "d3" }, never, () => {})).rejects.toMatchObject({ code: "not_found" });
    // Nothing piped: the engine's words, naming both flags, again.
    await expect(completeWithPipedEvidence(tool.mockImplementation(async () => { throw needs; }), { draft: "d1" }, stdin(""), () => {})).rejects.toBe(needs);
  });

  it("identity complete on a pipe nobody writes says so on stderr, then gives up with the usage error naming --evidence-file", async () => {
    vi.useFakeTimers();
    try {
      const notes: string[] = [];
      const needs = async () => { throw new CliError("usage", "Missing what ssh-keygen printed", { needs: "evidence" }); };
      const done = completeWithPipedEvidence(needs, { draft: "d1" }, () => new Promise<string>(() => {}), (note) => notes.push(note));
      const failed = expect(done).rejects.toMatchObject({ code: "usage", message: "Missing what the tool printed: nothing came on stdin in 60 s; give it there (… | ghostly identity complete d1) or as --evidence-file f" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(notes).toEqual(["Waiting for what the tool printed on stdin (… | ghostly identity complete d1): give it there or as --evidence-file f"]);
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
    } finally { vi.useRealTimers(); }
  });

  it("other commands are left alone", async () => {
    const params = { chat: "x" };
    expect(await secretsFromStdin("chat.get", params, never)).toBeUndefined();
    expect(params).toEqual({ chat: "x" });
  });
});
