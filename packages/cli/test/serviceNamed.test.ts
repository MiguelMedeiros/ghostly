import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { ghostly } from "./support/cli";
// covers: headless.services

/**
 * A service is named by its id, made from its name: `service add "My App"` answers `my-app`. Given its name instead,
 * `service enable "My App"` said `No service "My App"`, while `service list` showed a service of that name. Now a name
 * only one service has names that service (compared as a chat's label is: one case); an id comes first, and a name
 * several services share is refused as before (`not_found`, 3), naming their ids.
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
  it("names the one service that has it, answering its id", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "service.enable", { service: "My App", off: true })).toEqual({ service: "my-app", enabled: false });
    expect(node.setServiceEnabled).toHaveBeenLastCalledWith({ serviceId: "my-app", enabled: false });
    expect(await callApi(ctx, "service.enable", { service: "my app" })).toEqual({ service: "my-app", enabled: true });
    expect(await callApi(ctx, "service.remove", { service: "My App" })).toEqual({ removed: "my-app" });
    expect(node.removeService).toHaveBeenLastCalledWith({ serviceId: "my-app" });
  });

  it("takes an id first, though another service has it as its name", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "service.enable", { service: "same" })).toEqual({ service: "same", enabled: true });
    expect(node.setServiceEnabled).toHaveBeenLastCalledWith({ serviceId: "same", enabled: true });
  });

  it("refuses a name several services share, listing every id, and changes nothing", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "service.enable", { service: "SAME" })).rejects.toMatchObject({
      code: "not_found",
      message: 'No service with id "SAME". "SAME" is the name of 2 services, same and same-2: use one of their ids (ghostly service list)',
    });
    expect(node.setServiceEnabled).not.toHaveBeenCalled();
  });

  it("keeps the old words for a text that is neither an id nor a name", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "service.enable", { service: "nope" })).rejects.toMatchObject({ code: "not_found", message: 'No service "nope" (ghostly service list)' });
  });

  it("says in the help that <service> is the id service add and service list show, or a name no other service has", async () => {
    for (const command of ["enable", "remove", "share"]) {
      const help = await ghostly(["help", "service", command]);
      expect(help.code).toBe(0);
      expect(help.stdout.replace(/\s+/g, " ")).toContain("<service> is its id, as service add and service list show it, or its name if no other service has it");
    }
  });
});
