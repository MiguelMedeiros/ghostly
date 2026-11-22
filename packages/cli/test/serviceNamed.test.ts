import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { ghostly } from "./support/cli";
// covers: headless.services

/**
 * A service is named by its id, made from its name: `service add "My App"` answers `my-app`. Given its name instead,
 * `service enable "My App"` said `No service "My App"`, while `service list` showed a service of that name. The
 * refusal keeps its code and exit (`not_found`, 3) and now names the id to use; a name several services share names
 * them all.
 */
function fake() {
  const services = [
    { id: "my-app", name: "My App", target: "http://127.0.0.1:4893", enabled: true, sharedWith: [], requests: 0 },
    { id: "same", name: "Same", target: "http://127.0.0.1:4894", enabled: true, sharedWith: [], requests: 0 },
    { id: "same-2", name: "Same", target: "http://127.0.0.1:4895", enabled: true, sharedWith: [], requests: 0 },
  ];
  const node = {
    getState: () => ({ links: [], groups: [], settings: {}, transport: {}, services }) as unknown as EngineState,
    setServiceEnabled: vi.fn(async () => {}),
    removeService: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("a service named by its name, not its id", () => {
  it("is refused as not_found in words that name its id", async () => {
    const { ctx, node } = fake();
    for (const method of ["service.enable", "service.remove"]) {
      await expect(callApi(ctx, method, { service: "My App", off: true })).rejects.toMatchObject({
        code: "not_found",
        message: 'No service with id "My App". "My App" is the name of my-app: use its id (ghostly service list)',
      });
    }
    expect(node.setServiceEnabled).not.toHaveBeenCalled();
    expect(node.removeService).not.toHaveBeenCalled();
  });

  it("lists every id of a name several services share", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "service.enable", { service: "Same" })).rejects.toMatchObject({
      code: "not_found",
      message: 'No service with id "Same". "Same" is the name of 2 services, same and same-2: use one of their ids (ghostly service list)',
    });
  });

  it("keeps the old words for a text that is neither an id nor a name", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "service.enable", { service: "nope" })).rejects.toMatchObject({ code: "not_found", message: 'No service "nope" (ghostly service list)' });
  });

  it("says in the help that <service> is the id service add and service list show", async () => {
    for (const command of ["enable", "remove", "share"]) {
      const help = await ghostly(["help", "service", command]);
      expect(help.code).toBe(0);
      expect(help.stdout.replace(/\s+/g, " ")).toContain("<service> is its id, as service add and service list show it");
    }
  });
});
