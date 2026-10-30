import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";

/** `ghostly engine` reaches the engine's own send calls: the secret guard `send` has holds there too (docs/CLI.md § Safety). */
describe("ghostly engine and the secret guard", { timeout: 60_000 }, () => {
  it("refuses a seed in sendMessage and sendGroupMessage (exit 5) unless --force", async () => {
    const dir = home("engine-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    const sends: [string, Record<string, unknown>][] = [
      ["sendMessage", { linkId: "nope", text: SEED }],
      ["sendGroupMessage", { groupId: "nope", text: SEED }],
    ];
    for (const [method, params] of sends) {
      expect(error(await ghostly(["--home", dir, "engine", method, JSON.stringify(params)]), "confirm", 5).message, method).toMatch(/looks like a secret.*--force/);
      expect(error(await ghostly(["--home", dir, "engine", method, "-"], { input: JSON.stringify(params) }), "confirm", 5).message, method).toMatch(/--force/);
    }
    // With --force the guard lets it through to the engine, which answers for a group it does not have.
    expect(ok(await ghostly(["--home", dir, "engine", "sendGroupMessage", JSON.stringify(sends[1][1]), "--force"]))).toMatchObject({ error: expect.any(String) });
  });

  it("refuses a seed in a payment's memo or a group file's caption (exit 5) unless --force", async () => {
    const dir = home("memo-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    const calls: [string, Record<string, unknown>][] = [
      ["sendPayment", { linkId: "nope", amount: 1, memo: SEED, timestamp: 1 }],
      ["requestPayment", { linkId: "nope", amount: 1, memo: SEED, timestamp: 1 }],
      ["requestGroupPayment", { groupId: "nope", amount: 1, memo: SEED, timestamp: 1, rail: "cashu" }],
      ["askToPay", { linkId: "nope", amount: 1, method: "arkade", memo: SEED, timestamp: 1 }],
      ["sendGroupFile", { groupId: "nope", file: { name: "a.txt", type: "text/plain", size: 1, data: "YQ==" }, caption: SEED }],
    ];
    for (const [method, params] of calls) {
      expect(error(await ghostly(["--home", dir, "engine", method, JSON.stringify(params)]), "confirm", 5).message, method).toMatch(/looks like a secret.*--force/);
    }
    // agents#1624: the payment sheet's own path, an invoice's description and a Lightning address's comment.
    const more: [string, Record<string, unknown>][] = [
      ["preparePayment", { target: { method: "cashu", provider: "https://mint.example", address: "x", network: "testnet" }, amount: 1, feeCap: 0, payee: "x", linkId: "nope", memo: SEED }],
      ["preparePayment", { target: { method: "fedimint", provider: "f", address: "x", network: "testnet" }, amount: 1, feeCap: 0, payee: "x", linkId: "nope", requestId: "r", memo: SEED }],
      ["fedimintInvoice", { federation: "nope", amount: 1, memo: SEED }],
      ["lnurlInvoice", { id: "nope", amount: 1, comment: SEED }],
    ];
    for (const [method, params] of more) {
      expect(error(await ghostly(["--home", dir, "engine", method, JSON.stringify(params)]), "confirm", 5).message, method).toMatch(new RegExp(`looks like a secret.*call ${method} with --force`));
    }
    // With --force it reaches the engine, which answers for a link it does not have.
    expect((await ghostly(["--home", dir, "engine", "lnurlInvoice", JSON.stringify(more[3][1]), "--force"])).code).not.toBe(5);
    // `pay <address> --comment` holds it before it looks the address up.
    expect(error(await ghostly(["--home", dir, "pay", "bob@example.invalid", "--amount", "1", "--comment", SEED]), "confirm", 5).message).toMatch(/comment looks like a secret.*pay with --force/);
    expect((await ghostly(["--home", dir, "pay", "lnbc1notaninvoice", "--comment", SEED, "--force"])).code).not.toBe(5);
    // `chat pay` and `chat request` hold it too, before they look for the chat.
    for (const verb of ["pay", "request"]) {
      expect(error(await ghostly(["--home", dir, "chat", verb, "nope", "1", "--memo", SEED]), "confirm", 5).message, verb).toMatch(/memo looks like a secret.*--force/);
      // With --force (or a memo that is no secret) it goes on, to the chat this profile does not have.
      error(await ghostly(["--home", dir, "chat", verb, "nope", "1", "--memo", SEED, "--force"]), "not_found", 3);
      error(await ghostly(["--home", dir, "chat", verb, "nope", "1", "--memo", "lunch"]), "not_found", 3);
    }
  });
});
