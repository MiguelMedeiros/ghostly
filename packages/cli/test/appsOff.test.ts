import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineClientSink } from "@ghostly/browser/engine/server";
import type { RpcResponse } from "@ghostly/browser/shared/rpc";
import { ENGINE_METHODS } from "../src/engineMethods";
import { profilePaths } from "../src/profiles";
import type { Runtime } from "../src/runtime/engine";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.daemon

/*
 * The CLI runs no mini-app (WISP 1200 § Per client: CLI), and the bot side of apps/1 is phase 2: its engine is made with
 * `apps: false`, so it offers no apps/1 to a contact and refuses every app call, whatever `APPS_ENABLED` says. Here the
 * build's flag is on, as in a release that ships apps, and the runtime is the daemon's own (`startRuntime`), in this
 * process, on a new profile and on this machine's network only. That an engine made so offers no apps/1 on a live
 * chat is packages/browser/test/appsPinnedOff.test.ts.
 */

vi.mock("@ghostly/browser/shared/features", async (actual) => ({ ...await actual<typeof import("@ghostly/browser/shared/features")>(), APPS_ENABLED: true }));

const root = mkdtempSync(join(tmpdir(), "ghostly-apps-off-"));
const env = { ...isolatedNetworkEnv(), GHOSTLY_WEBRTC: "0" };
const before: Record<string, string | undefined> = {};
let runtime: Runtime | undefined;

beforeAll(async () => {
  for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; }
  const paths = profilePaths(join(root, "home"), "apps-off");
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  runtime = await (await import("../src/runtime/engine")).startRuntime(paths);
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe("the CLI's engine with APPS_ENABLED on", () => {
  it("refuses every app call", async () => {
    expect((await import("@ghostly/browser/shared/features")).APPS_ENABLED).toBe(true);
    const server = runtime!.server;
    const answers = new Map<number, RpcResponse>();
    const page: EngineClientSink = { post: (message) => { if (message.kind === "response") answers.set(message.id, message); } };
    server.attach(page);
    let next = 0;
    const errorOf = async (method: string, params?: unknown) => {
      const request = { kind: "request" as const, id: ++next, method, params } as Parameters<typeof server.handle>[1];
      await server.handle(page, request);
      return answers.get(request.id)?.error;
    };
    try {
      const methods = ENGINE_METHODS.filter((method) => /^app[A-Z]/.test(method));
      expect(methods.length).toBeGreaterThan(20);
      for (const method of methods) expect(await errorOf(method, {}), method).toBe("Apps do not run on this client");
    } finally { server.detach(page); }
  });
});
