import { afterEach, expect, it, vi } from "vitest";
import { checkVersionFeed } from "../src/updateFeed";
// covers: app.updates.extension

const answer = (body: string, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
afterEach(() => vi.unstubAllGlobals());
const check = (currentVersion = "1.2.3", currentBuild?: string, buildGone?: boolean) => checkVersionFeed({ url: "https://app.example/version.json", currentVersion, currentBuild, buildGone, apply: "reload" });

it("offers a newer version, and nothing when this one is current or newer", async () => {
  answer('{"version":"1.3.0"}');
  expect(await check()).toEqual({ version: "1.3.0", build: undefined, apply: "reload" });
  answer('{"version":"1.2.3"}');
  expect(await check()).toBeNull();
  answer('{"version":"1.2.2"}');
  expect(await check()).toBeNull();
});

it("compares version numbers only: a new build of the same version is not an update", async () => {
  // "Ghostly 1.1.4 is available" on 1.1.4, after a redeploy of the same version.
  answer('{"version":"1.1.4","build":"b2"}');
  expect(await check("1.1.4", "b1")).toBeNull();
  expect(await check("v1.1.4", "b1")).toBeNull();
  expect(await check("1.1.4-beta.1", "b1")).toBeNull();
  answer('{"version":"1.1.4+b2"}');
  expect(await check("1.1.4+b1", "b1")).toBeNull();
  answer('{"version":"1.1.3","build":"b2"}');
  expect(await check("1.1.4", "b1")).toBeNull();
  answer('{"version":"1.1.10","build":"b2"}');
  expect(await check("1.1.9", "b1")).toMatchObject({ version: "1.1.10", build: "b2" });
});

it("once this build is gone from the server, another build of the same version is an update, as a new build", async () => {
  // A tab on b1 after a redeploy of 1.1.4: its wallet's WebAssembly 404s, and nothing but b2 can load it.
  answer('{"version":"1.1.4","build":"b2"}');
  expect(await check("1.1.4", "b1", true)).toEqual({ version: "1.1.4", build: "b2", replaced: true, apply: "reload" });
  // The same build still deployed, or a feed that names none: nothing to offer.
  expect(await check("1.1.4", "b2", true)).toBeNull();
  answer('{"version":"1.1.4"}');
  expect(await check("1.1.4", "b1", true)).toBeNull();
  // A newer version is an update as before, not a new build.
  answer('{"version":"1.1.5","build":"b2"}');
  expect(await check("1.1.4", "b1", true)).toEqual({ version: "1.1.5", build: "b2", apply: "reload" });
  // A rollback: the files are gone all the same, so it is offered, by its version ("Ghostly 1.1.3 is available"),
  // never as a new build of a version this tab does not run. Still deployed, an older version is no update.
  answer('{"version":"1.1.3","build":"b0"}');
  expect(await check("1.1.4", "b1", true)).toEqual({ version: "1.1.3", build: "b0", apply: "reload" });
  expect(await check("1.1.4", "b1")).toBeNull();
});

it("never trusts what the network says: bounded, typed, and a failure is not an update", async () => {
  for (const body of ["not json", "null", "[]", '{"version":1}', `{"version":"${"9".repeat(65)}"}`, `{"version":"2.0.0","pad":"${"x".repeat(5000)}"}`]) {
    answer(body);
    await expect(check(), body.slice(0, 30)).rejects.toThrow("something else");
  }
  answer('{"version":"2.0.0","build":' + JSON.stringify("x".repeat(65)) + "}");
  expect(await check()).toEqual({ version: "2.0.0", build: undefined, apply: "reload" });
  answer('{"version":"one.two"}');
  expect(await check()).toBeNull();
  answer("", 503);
  await expect(check()).rejects.toThrow("503");
});

it("asks without cookies, referrer or cache", async () => {
  answer('{"version":"1.2.3"}');
  await check();
  const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1];
  expect(init).toMatchObject({ cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  expect(init.signal).toBeInstanceOf(AbortSignal);
});
