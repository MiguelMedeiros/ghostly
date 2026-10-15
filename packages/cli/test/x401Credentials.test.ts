import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newX401HolderKey, type X401HolderJwk } from "../../core/src/x401Credential";
import { issueSdJwtVc } from "../../core/test/support/sdJwtIssuer";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * x401 credentials (WISP 3xx) from the command line: a holder key for the issuer, the issued credential kept, listed
 * without its values unless asked, and removed. All of it stays on this device: no relay hears of it.
 */
describe("ghostly x401 key and credential", { timeout: 120_000 }, () => {
  const dir = home("x401-credentials");
  const requests: string[] = [];
  let close = () => {};
  let env: NodeJS.ProcessEnv;
  const run = (...args: string[]) => ghostly(["--home", dir, ...args], { env });
  const file = (name: string, text: string) => { const path = join(dir, name); writeFileSync(path, text); return path; };

  beforeAll(async () => {
    const server = createServer((request, response) => { requests.push(request.method ?? "?"); response.writeHead(404).end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => { server.closeAllConnections(); server.close(); };
    env = { GHOSTLY_PKARR_RELAYS: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  });
  afterAll(() => close());

  it("keeps a credential bound to a key it made, lists it without values unless asked, and removes it", async () => {
    const key = ok(await run("x401", "key", "new"));
    const jwk = key.jwk as X401HolderJwk;
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"]);

    const added = ok(await run("x401", "credential", "add", file("licence.txt", issueSdJwtVc({ holder: jwk })), "--label", "work licence")).credential as Record<string, unknown>;
    expect(added).toMatchObject({ label: "work licence", format: "dc+sd-jwt", type: "https://issuer.example/licence", issuer: "https://issuer.example", notBefore: null, expiresAt: 4_102_444_800_000 });
    expect(added.disclosable).toContainEqual(["licence_number"]);

    const listed = await run("x401", "credential", "list");
    expect(listed.stdout).not.toContain("TEST-0001");
    expect(listed.stdout).not.toContain("Alice");
    const [one] = ok(listed).credentials as Record<string, unknown>[];
    expect(one).toMatchObject({ id: added.id, label: "work licence" });
    expect(one.claims).toContainEqual(["address", "street"]);
    expect(one).not.toHaveProperty("values");

    const shown = ok(await run("x401", "credential", "list", "--show-secret")).credentials as Record<string, unknown>[];
    expect(shown[0].values).toMatchObject({ given_name: "Alice", licence_number: "TEST-0001" });

    // The key went with the credential it is bound to: the same credential again has no key to go to.
    expect(error(await run("x401", "credential", "add", file("again.txt", issueSdJwtVc({ holder: jwk }))), "bad_request", 1).message).toMatch(/kept already|did not make/);

    expect(ok(await run("x401", "credential", "remove", added.id as string))).toEqual({ removed: added.id });
    expect(ok(await run("x401", "credential", "list")).credentials).toEqual([]);
    expect(error(await run("x401", "credential", "remove", added.id as string), "not_found", 3).message).toMatch(/x401 credential list/);
    expect(requests).toEqual([]);
  });

  it("reads the credential from stdin with -", async () => {
    const jwk = ok(await run("x401", "key", "new")).jwk as X401HolderJwk;
    const added = ok(await ghostly(["--home", dir, "x401", "credential", "add", "-"], { env, input: issueSdJwtVc({ holder: jwk }) })).credential as Record<string, unknown>;
    expect(added.label).toBe("https://issuer.example/licence");
    ok(await run("x401", "credential", "remove", added.id as string));
  });

  it("refuses a credential bound to a key this profile did not make, an expired one, and what is no SD-JWT VC", async () => {
    expect(error(await run("x401", "credential", "add", file("other.txt", issueSdJwtVc({ holder: newX401HolderKey().jwk }))), "bad_request", 1).message).toMatch(/x401 key new/);
    const jwk = ok(await run("x401", "key", "new")).jwk as X401HolderJwk;
    expect(error(await run("x401", "credential", "add", file("old.txt", issueSdJwtVc({ holder: jwk, payload: { exp: 1_700_000_000 } }))), "bad_request", 1).message).toMatch(/expired/);
    expect(error(await run("x401", "credential", "add", file("junk.txt", "hello")), "bad_request", 1).message).toMatch(/Not an SD-JWT VC/);
    expect(error(await run("x401", "credential", "add", join(dir, "missing.txt")), "usage", 2).message).toMatch(/Cannot read/);
    expect(requests).toEqual([]);
  });

  it("answers the words of a group with its commands", async () => {
    expect(error(await run("x401", "credential"), "usage", 2).message).toBe("ghostly x401 credential takes a command: add, list or remove (ghostly help x401 credential)");
    expect(error(await run("x401", "credential", "frob"), "usage", 2).message).toBe("Unknown command: x401 credential frob: ghostly x401 credential takes add, list or remove (ghostly help x401 credential)");
    expect(error(await run("x401"), "usage", 2).message).toBe("ghostly x401 takes a command: credential or key (ghostly help x401)");
    expect((await ghostly(["help", "x401", "credential", "add"])).stdout).toContain("Usage: ghostly x401 credential add <file|-> [--label <name>]");
  });
});
