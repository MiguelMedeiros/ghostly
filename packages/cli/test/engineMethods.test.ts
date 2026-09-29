import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ENGINE_METHODS, SECRET_RESULTS } from "../src/engineMethods";
// covers: headless.engine-passthrough

it("passes through exactly the app's EngineApi, and marks only its calls as secret", () => {
  const source = readFileSync(new URL("../../browser/src/shared/rpc.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export interface EngineApi {"));
  const api = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/^ {2}([a-zA-Z0-9]+)\(/gm)].map((m) => m[1]);
  expect([...ENGINE_METHODS].sort()).toEqual(api.sort());
  for (const method of SECRET_RESULTS) expect(api).toContain(method);
});
