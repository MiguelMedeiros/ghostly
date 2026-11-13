import { describe, expect, it } from "vitest";
import { parseLocalTarget } from "@ghostly/core";
import { SERVICE_METHODS } from "../src/services";
import { asCliError } from "../src/errors";
import type { ApiContext } from "../src/apiKit";
// covers: headless.services

/*
 * agents#894 (widened 2026-10-19): `service add` answered its own input mistakes with code `engine` (exit 1, "the engine
 * failed") while its sibling refusals were `bad_request` or `refused`: the engine's target check threw plain errors.
 */
const added: string[] = [];
/** The engine's addService checks the target as the real one does (browser platform/services.ts). */
const ctx = { runtime: { server: { node: { addService: ({ target }: { target: string }) => { parseLocalTarget(target); added.push(target); return { serviceId: "w" }; } } } } } as unknown as ApiContext;
const add = async (target: string) => {
  try { await SERVICE_METHODS["service.add"](ctx, { name: "w", target }); return "ok"; } catch (error) { const e = asCliError(error); return `${e.code}: ${e.message}`; }
};

describe("service add's target", () => {
  it.each([
    ["http://localhost:4773/path?q=1", /^bad_request: The target cannot contain a query or fragment: http:\/\/localhost:4773\/path$/],
    ["http://localhost:4773/#frag", /^bad_request: The target cannot contain a query or fragment/],
    ["http://user:pw@127.0.0.1:4773", /^bad_request: Credentials in the target URL are not supported/],
    ["ftp://127.0.0.1:4773", /^bad_request: Only http and https targets are supported/],
    ["http://127.0.0.2:4773", /^refused: Only services on this machine can be shared \(localhost, 127\.0\.0\.1 or \[::1\]\): http:\/\/127\.0\.0\.2:4773\/$/],
    ["https://example.com", /^refused: Only services on this machine can be shared \(localhost, 127\.0\.0\.1 or \[::1\]\)/],
    ["nope", /^refused: Only services on this machine/],
    ["http://[", /^bad_request: Not a valid URL: http:\/\/\[$/],
    // agents#1907: port 0 is no port a web app listens on, so every contact who opened it got a failure.
    ["http://127.0.0.1:0", /^bad_request: Port 0 is not a port a web app can listen on: http:\/\/127\.0\.0\.1:0\/$/],
    ["http://localhost:0/app", /^bad_request: Port 0 is not a port/],
  ])("%s is the person's to fix, not the engine failing", async (target, said) => {
    expect(await add(target)).toMatch(said);
  });

  it("a refusal names the target without the password or the token it refused", async () => {
    const credentials = await add("http://user:s3cretpw@127.0.0.1:4773/app");
    expect(credentials).toBe("bad_request: Credentials in the target URL are not supported: http://127.0.0.1:4773/app");
    const query = await add("http://localhost:8888/?token=t0ken42#also-s3cret");
    expect(query).toMatch(/^bad_request: The target cannot contain a query or fragment: http:\/\/localhost:8888\/$/);
    for (const said of [credentials, query]) for (const secret of ["s3cretpw", "user", "t0ken42", "s3cret"]) expect(said).not.toContain(secret);
  });

  it("a target on this machine is added", async () => {
    expect(await add("http://127.0.0.1:4773/app")).toBe("ok");
    expect(added).toEqual(["http://127.0.0.1:4773/app"]);
  });

  // A target without its scheme, as the engine takes it (`localhost:3400`): `new URL` read `localhost:` as the scheme
  // and refused it as "only 127.0.0.1, localhost", and `127.0.0.1:8080` was "Not a URL".
  it.each(["localhost:8080", "127.0.0.1:8080/app", "[::1]:8080"])("%s, without http://, is added", async (target) => {
    expect(await add(target)).toBe("ok");
    expect(added.at(-1)).toBe(target);
  });
});
