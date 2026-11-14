import { describe, expect, it } from "vitest";
import { SERVICE_METHODS } from "../src/services";
import { asCliError } from "../src/errors";
import type { ApiContext } from "../src/apiKit";
// covers: headless.services

/*
 * `service add` with a name of spaces answered `engine` (exit 1, "the engine failed"), the engine's plain Error; a
 * longer name than the engine keeps was cut with exit 0 and no word. Other names (`profile set --name`, a chat's) are
 * checked first and refused as `bad_request`, naming the limit.
 */
const added: string[] = [];
/** The engine's addService takes the name as the real one does (browser engine/node.ts). */
const ctx = { runtime: { server: { node: { addService: ({ name }: { name: string }) => {
  const clean = name.trim().slice(0, 48);
  if (!clean) throw new Error("Give the service a name");
  added.push(clean);
  return { serviceId: "w" };
} } } } } as unknown as ApiContext;
const add = async (name: string) => {
  try { await SERVICE_METHODS["service.add"](ctx, { name, target: "http://127.0.0.1:4773" }); return "ok"; } catch (error) { const e = asCliError(error); return { code: e.code, message: e.message, details: e.details }; }
};

describe("service add's name", () => {
  it("a name with no character that shows is the person's to fix, not the engine failing", async () => {
    for (const name of ["   ", "\t", "​"]) expect(await add(name)).toMatchObject({ code: "bad_request", message: "A service's name needs a character that shows" });
  });

  it("a name longer than the engine keeps is refused, naming the limit, not cut", async () => {
    expect(await add("x".repeat(60))).toEqual({ code: "bad_request", message: "A service's name is up to 48 characters as stored (this one is 60)", details: { length: 60, max: 48 } });
    // The engine counts UTF-16 units, where an emoji counts as 2: 30 of them would be cut to 24.
    expect(await add("👻".repeat(30))).toMatchObject({ code: "bad_request", details: { length: 60, max: 48 } });
    expect(added).toEqual([]);
  });

  it("a name the engine keeps whole is added, as it is shown", async () => {
    expect(await add("x".repeat(48))).toBe("ok");
    expect(await add("  My   app ")).toBe("ok");
    expect(added).toEqual(["x".repeat(48), "My app"]);
  });
});
