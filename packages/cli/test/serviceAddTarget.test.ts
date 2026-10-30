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
    ["http://localhost:4773/path?q=1", /^bad_request: The target cannot contain a query or fragment: http:\/\/localhost:4773\/path\?q=1$/],
    ["http://localhost:4773/#frag", /^bad_request: The target cannot contain a query or fragment/],
    ["http://user:pw@127.0.0.1:4773", /^bad_request: Credentials in the target URL are not supported/],
    ["ftp://127.0.0.1:4773", /^bad_request: Only http and https targets are supported/],
    ["http://127.0.0.2:4773", /^refused: /],
    ["https://example.com", /^refused: Only a web app on this machine/],
    ["nope", /^bad_request: Not a URL/],
  ])("%s is the person's to fix, not the engine failing", async (target, said) => {
    expect(await add(target)).toMatch(said);
  });

  it("a target on this machine is added", async () => {
    expect(await add("http://127.0.0.1:4773/app")).toBe("ok");
    expect(added).toEqual(["http://127.0.0.1:4773/app"]);
  });
});
