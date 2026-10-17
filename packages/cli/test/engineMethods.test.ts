import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ENGINE_METHODS, ENGINE_PARAMS, SECRET_RESULTS, engineParamsProblem } from "../src/engineMethods";
import { ghostly, home, ok } from "./support/cli";
// covers: headless.engine-passthrough

const source = readFileSync(new URL("../../browser/src/shared/rpc.ts", import.meta.url), "utf8");

it("passes through exactly the app's EngineApi, and marks only its calls as secret", () => {
  const body = source.slice(source.indexOf("export interface EngineApi {"));
  const api = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/^ {2}([a-zA-Z0-9]+)\(/gm)].map((m) => m[1]);
  expect([...ENGINE_METHODS].sort()).toEqual(api.sort());
  for (const method of SECRET_RESULTS) expect(api).toContain(method);
});

it("says what each call takes as rpc.ts types it", () => {
  expect(ENGINE_PARAMS).toEqual(engineShapes(source));
  expect(ENGINE_PARAMS.renameLink).toBe("{ linkId, label }");
  expect(ENGINE_PARAMS.usdtLock).toBe("{ network? }?");
  expect(ENGINE_PARAMS.createLink).toBe("");
});

it("finds a call given less than it takes", () => {
  expect(engineParamsProblem("renameLink", undefined)).toBe("no parameters given");
  expect(engineParamsProblem("renameLink", {})).toBe("linkId, label missing");
  expect(engineParamsProblem("renameLink", { linkId: "c" })).toBe("label missing");
  expect(engineParamsProblem("renameLink", { linkId: "c", label: "x" })).toBeUndefined();
  expect(engineParamsProblem("updateSettings", { nick: "x" })).toBe("settings missing");
  // null is a value: no chat on screen.
  expect(engineParamsProblem("setActiveLink", { linkId: null })).toBeUndefined();
  expect(engineParamsProblem("usdtLock", undefined)).toBeUndefined();
  expect(engineParamsProblem("createLink", undefined)).toBeUndefined();
  expect(engineParamsProblem("getMessages", {})).toBe("linkId missing");
  // A type's name is not looked into.
  expect(engineParamsProblem("walletCreate", {})).toBeUndefined();
  expect(engineParamsProblem("walletCreate", undefined)).toBe("no parameters given");
});

it("`engine --list --verbose` names what each call takes", { timeout: 60_000 }, async () => {
  const dir = home("engine-list");
  const listed = ok(await ghostly(["--home", dir, "engine", "--list", "--verbose"])) as { methods: string[]; takes: Record<string, string> };
  expect(listed.methods).toContain("renameLink");
  expect(listed.takes).toMatchObject({ renameLink: "{ linkId, label }", updateSettings: "{ settings }", getMessages: "{ linkId }", getState: "" });
  expect(Object.keys(listed.takes).sort()).toEqual(listed.methods);
  expect(ok(await ghostly(["--home", dir, "engine", "--list"]))).toEqual({ methods: listed.methods });
});

/** Each EngineApi call's parameter, in ENGINE_PARAMS' words. */
function engineShapes(text: string): Record<string, string> {
  const start = text.indexOf("export interface EngineApi {");
  const body = text.slice(start, text.indexOf("\n}\n", start));
  const shapes: Record<string, string> = {};
  for (const m of body.matchAll(/^ {2}([a-zA-Z0-9]+)\(/gm)) {
    let i = m.index + m[0].length;
    const from = i;
    for (let depth = 1; depth; i++) depth += "({[<".includes(body[i]) ? 1 : ")}]>".includes(body[i]) ? -1 : 0;
    shapes[m[1]] = shapeOf(body.slice(from, i - 1).trim());
  }
  return shapes;
}

function shapeOf(param: string): string {
  if (!param) return "";
  const [, optional, type] = /^params(\??)\s*:\s*([\s\S]*)$/.exec(param) ?? [];
  if (type === undefined) throw new Error(`Not a params: ${param}`);
  const trimmed = type.trim();
  return (oneObject(trimmed) ? `{ ${keysOf(trimmed.slice(1, -1)).join(", ")} }` : trimmed.replace(/import\("[^"]+"\)\./g, "").replace(/\s+/g, " ")) + optional;
}

/** Whether the type is one object literal (not `{…} | {…}`, nor `{…} & T`). */
function oneObject(type: string): boolean {
  if (type[0] !== "{") return false;
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    if ("({[<".includes(type[i])) depth++;
    else if (")}]>".includes(type[i]) && !--depth) return i === type.length - 1;
  }
  return false;
}

function keysOf(inner: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let next = true;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ("({[<".includes(c)) depth++;
    else if (")}]>".includes(c)) depth--;
    else if (!depth && (c === ";" || c === ",")) next = true;
    else if (!depth && next && /\S/.test(c)) {
      const key = /^([a-zA-Z0-9]+)(\??)\s*:/.exec(inner.slice(i));
      if (!key) throw new Error(`Not a key: ${inner.slice(i, i + 40)}`);
      keys.push(key[1] + key[2]);
      i += key[0].length - 1;
      next = false;
    }
  }
  return keys;
}
