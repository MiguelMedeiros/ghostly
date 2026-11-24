import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { commands } from "../src/commands/services";
// covers: headless.services

/*
 * A shared app's name reaches every contact it is shared with, as a group's name reaches its members. `service add` and
 * the engine's own `addService` sent one that looks like a recovery phrase or a Cashu token with no question, where
 * `group create` and `createGroup` ask for `--force`.
 */

/** Twelve short BIP39 words: 47 characters, a name the engine keeps whole (48). */
const PHRASE = "act add age aim air all any arm art ask bag bar";
/** Key 0x0101…01: it has never held anything. Longer than a service's name: the engine would keep its first 48. */
const NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";
const TARGET = "http://127.0.0.1:4773";

function fake() {
  const node = {
    getState: () => ({ links: [], groups: [], services: [], settings: {} }) as unknown as EngineState,
    addService: vi.fn(({ name }: { name: string }) => ({ serviceId: name.trim().slice(0, 48).toLowerCase().replace(/\W+/g, "-") })),
  };
  const ctx = {
    runtime: { server: { node }, paths: { name: "default" } },
    hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] },
    calls: { list: () => [], forgetChat: vi.fn() },
    groupAuto: { get: () => ({ on: false, from: [] }), forgetChat: vi.fn() },
    mode: "daemon", version: "test",
  } as unknown as ApiContext;
  return { ctx, node };
}

describe("a shared app's name and the secret guard", () => {
  it("service add refuses a name that looks like a recovery phrase unless --force", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "service.add", { name: PHRASE, target: TARGET })).rejects.toMatchObject({
      code: "confirm", message: expect.stringContaining("The service's name looks like a secret (a seed or a private key); add it with --force"), details: { kind: "mnemonic" },
    });
    expect(node.addService).not.toHaveBeenCalled();
    await callApi(ctx, "service.add", { name: PHRASE, target: TARGET, force: true });
    expect(node.addService).toHaveBeenCalledWith({ name: PHRASE, target: TARGET });
  });

  it("a plain name is added at once", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "service.add", { name: "Atlas", target: TARGET })).toEqual({ service: "atlas", serviceId: "atlas" });
    expect(node.addService).toHaveBeenCalledWith({ name: "Atlas", target: TARGET });
  });

  it("the engine's own addService reads the name whole, before the engine cuts it", async () => {
    const { ctx, node } = fake();
    for (const name of [PHRASE, NSEC]) {
      await expect(callApi(ctx, "engine.call", { method: "addService", params: { name, target: TARGET } })).rejects.toMatchObject({ code: "confirm" });
    }
    expect(node.addService).not.toHaveBeenCalled();
    await callApi(ctx, "engine.call", { method: "addService", params: { name: "Atlas", target: TARGET } });
    await callApi(ctx, "engine.call", { method: "addService", params: { name: NSEC, target: TARGET }, force: true });
    expect(node.addService).toHaveBeenCalledTimes(2);
  });

  it("`service add --force` passes force on", () => {
    const add = commands["service add"]!;
    expect(add.options).toHaveProperty("force");
    expect(add.params!({ options: { force: true } } as never, { name: "Atlas", target: TARGET } as never)).toEqual({ name: "Atlas", target: TARGET, force: true });
    expect(add.params!({ options: {} } as never, { name: "Atlas", target: TARGET } as never)).toEqual({ name: "Atlas", target: TARGET });
  });
});
