import { describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
// covers: headless.services

/**
 * `service add` names the service it made `service`, as `service share`, `enable` and `open` answer and take it.
 * Before, it answered the engine's `{ serviceId }` as is, the only command of the family with another key.
 * `serviceId` stays beside it for a release, for scripts that read it.
 */
describe("service add", () => {
  it("answers the new service as `service`, keeping `serviceId` beside it", async () => {
    const node = { getState: () => ({ services: [] }) as unknown as EngineState, addService: vi.fn(() => ({ serviceId: "web" })) };
    const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
    expect(await callApi(ctx, "service.add", { name: "web", target: "http://127.0.0.1:5101" })).toEqual({ service: "web", serviceId: "web" });
    expect(node.addService).toHaveBeenCalledWith({ name: "web", target: "http://127.0.0.1:5101" });
  });
});
