import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appRef, type AppManifest } from "@ghostly/core";
import type { EngineClientSink } from "@ghostly/browser/engine/server";
import type { RpcResponse } from "@ghostly/browser/shared/rpc";
import { callApi, type ApiContext } from "../src/api";
import { servedApps } from "../src/appServe";
import { profilePaths } from "../src/profiles";
import type { Runtime } from "../src/runtime/engine";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.daemon

/*
 * `app serve` (WISP 1200 § A bot on the other side): a profile serves an app from its signed bundle, each permission
 * the manifest asks answered by a `--grant`, and its engine then offers apps/1 with no store. The bundles are the
 * core's test vectors (packages/core/test/vectors/app-bundle.json).
 */

type Segment = { hex: string } | { fill: string; size: number };
const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../core/test/vectors/app-bundle.json"), "utf8")) as {
  valid: { name: string; bytes: Segment[]; read: { digest: string; manifest: AppManifest } }[];
  invalid: { name: string; refusal: string; bytes: Segment[] }[];
};
const bytesOf = (segments: Segment[]) => new Uint8Array(Buffer.concat(segments.map((s) => ("hex" in s ? Buffer.from(s.hex, "hex") : Buffer.alloc(s.size, Number.parseInt(s.fill, 16))))));
const vector = (name: string) => vectors.valid.find((v) => v.name.startsWith(name))!;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function profile(apps = false) {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-serve-"));
  dirs.push(dir);
  const ctx = { runtime: { paths: { dir }, apps } } as unknown as ApiContext;
  const file = (name: string, segments: Segment[]) => { const path = join(dir, `${name}.ghostlyapp`); writeFileSync(path, bytesOf(segments)); return path; };
  return { dir, ctx, file };
}

describe("app serve", () => {
  const plain = vector("the entry only"), full = vector("an icon, screenshots");

  it("serves a bundle whose permissions were granted, and keeps what a card needs", async () => {
    const { dir, ctx, file } = profile();
    const m = full.read.manifest;
    expect(m.permissions).toEqual(["chat", "name"]);
    const answer = await callApi(ctx, "app.serve", { bundle: file("full", full.bytes), grant: ["chat", "name"] }) as { served: Record<string, unknown>; offered: boolean; restart?: boolean };
    expect(answer.served).toMatchObject({
      ref: appRef(m.publisher, m.name), title: m.title, version: m.version, sequence: m.sequence, digest: full.read.digest,
      url: m.sources![0], permissions: ["chat", "name"], granted: ["chat", "name"],
    });
    // This engine started before the app was served: apps/1 comes with the next start.
    expect(answer).toMatchObject({ offered: false, restart: true });
    expect(servedApps(dir)).toHaveLength(1);
    expect(statSync(join(dir, "apps.json")).mode & 0o777).toBe(0o600);
    expect(await callApi(ctx, "app.served")).toMatchObject({ apps: [{ ref: answer.served.ref }], offered: false, restart: true });
  });

  it("refuses a permission the manifest asks and no --grant answers, naming it", async () => {
    const { dir, ctx, file } = profile();
    await expect(callApi(ctx, "app.serve", { bundle: file("full", full.bytes), grant: ["chat"] })).rejects.toMatchObject({ code: "confirm", message: expect.stringContaining("--grant name"), details: { missing: ["name"] } });
    await expect(callApi(ctx, "app.serve", { bundle: file("plain", plain.bytes) })).rejects.toMatchObject({ code: "confirm", details: { missing: ["chat"] } });
    expect(servedApps(dir)).toEqual([]);
  });

  it("refuses what cannot be granted here, what the app does not ask, and an app that talks to no contact", async () => {
    const { dir, ctx, file } = profile();
    await expect(callApi(ctx, "app.serve", { bundle: file("plain", plain.bytes), grant: ["chat", "internet"] })).rejects.toMatchObject({ code: "refused" });
    await expect(callApi(ctx, "app.serve", { bundle: file("plain", plain.bytes), grant: ["chat", "camera"] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "app.serve", { bundle: file("plain", plain.bytes), grant: ["chat", "name"] })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("does not ask for name") });
    await expect(callApi(ctx, "app.serve", { bundle: file("alone", vector("a version with no permission").bytes), grant: [] })).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("does not ask for chat") });
    await expect(callApi(ctx, "app.serve", { bundle: file("net", vector("an app that asks for the internet").bytes), grant: [] })).rejects.toMatchObject({ code: "refused" });
    await expect(callApi(ctx, "app.serve", { bundle: file("plain", plain.bytes), grant: ["chat"], url: "http://example.org/app.ghostlyapp" })).rejects.toMatchObject({ code: "bad_request" });
    expect(servedApps(dir)).toEqual([]);
  });

  it("refuses a bundle a client would refuse, with the client's reason", async () => {
    const { dir, ctx, file } = profile();
    for (const bad of vectors.invalid.filter((v) => v.refusal !== "too-large").slice(0, 12))
      await expect(callApi(ctx, "app.serve", { bundle: file("bad", bad.bytes), grant: ["chat"] }), bad.name).rejects.toMatchObject({ code: "refused", details: { reason: bad.refusal } });
    expect(servedApps(dir)).toEqual([]);
  });

  it("takes a newer version of a served app and never an older one", async () => {
    const { dir, ctx, file } = profile();
    const older = vectors.valid.find((v) => v !== full && appRef(v.read.manifest.publisher, v.read.manifest.name) === appRef(full.read.manifest.publisher, full.read.manifest.name) && v.read.manifest.sequence < full.read.manifest.sequence);
    expect(older, "a vector of the same app with a lower sequence").toBeDefined();
    const grantOf = (v: typeof full) => v.read.manifest.permissions.filter((p) => p !== "internet");
    await callApi(ctx, "app.serve", { bundle: file("older", older!.bytes), grant: grantOf(older!) });
    await callApi(ctx, "app.serve", { bundle: file("full", full.bytes), grant: grantOf(full) });
    expect(servedApps(dir).map((a) => a.sequence)).toEqual([full.read.manifest.sequence]);
    await expect(callApi(ctx, "app.serve", { bundle: file("older", older!.bytes), grant: grantOf(older!) })).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("is older") });
    expect(servedApps(dir).map((a) => a.sequence)).toEqual([full.read.manifest.sequence]);
  });

  it("unserve removes an app by its reference or its name", async () => {
    const { dir, ctx, file } = profile(true);
    const { served } = await callApi(ctx, "app.serve", { bundle: file("plain", plain.bytes), grant: ["chat"] }) as { served: { ref: string } };
    await expect(callApi(ctx, "app.unserve", { ref: "nothing" })).rejects.toMatchObject({ code: "not_found" });
    expect(await callApi(ctx, "app.unserve", { ref: served.ref.split("/")[1] })).toEqual({ unserved: served.ref, apps: 0, offered: true });
    expect(servedApps(dir)).toEqual([]);
  });
});

describe("the engine of a profile that serves an app", () => {
  const root = mkdtempSync(join(tmpdir(), "ghostly-serve-engine-"));
  const env = { ...isolatedNetworkEnv(), GHOSTLY_WEBRTC: "0" };
  const before: Record<string, string | undefined> = {};
  let runtime: Runtime | undefined;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; }
    const paths = profilePaths(join(root, "home"), "serves");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const bundle = join(root, "app.ghostlyapp");
    writeFileSync(bundle, bytesOf(vector("the entry only").bytes));
    await callApi({ runtime: { paths, apps: false } } as unknown as ApiContext, "app.serve", { bundle, grant: ["chat"] });
    runtime = await (await import("../src/runtime/engine")).startRuntime(paths);
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });

  it("answers the chat calls of apps/1 and still refuses the store's", async () => {
    expect(runtime!.apps).toBe(true);
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
      const ref = servedApps(runtime!.paths.dir)[0].ref;
      // Past the apps gate: refused for the chat, which this new profile does not have.
      expect(await errorOf("appId", { linkId: "none", ref })).toBe("No such chat");
      expect(await errorOf("appOpen", { linkId: "none", ref, version: "1.0.0" })).toBe("No such chat");
      for (const method of ["appList", "appStoreList", "appCheckUpdates"]) expect(await errorOf(method, {}), method).toBe("Apps do not run on this client");
    } finally { server.detach(page); }
  });
});
