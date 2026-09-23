import { afterEach, expect, it, vi } from "vitest";
import { checkVersionFeed } from "../src/updateFeed";

const answer = (body: string, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
afterEach(() => vi.unstubAllGlobals());
const check = (currentVersion = "1.2.3", currentBuild?: string) => checkVersionFeed({ url: "https://app.example/version.json", currentVersion, currentBuild, apply: "reload" });

it("offers a newer version, and nothing when this one is current or newer", async () => {
  answer('{"version":"1.3.0"}');
  expect(await check()).toEqual({ version: "1.3.0", build: undefined, apply: "reload" });
  answer('{"version":"1.2.3"}');
  expect(await check()).toBeNull();
  answer('{"version":"1.2.2"}');
  expect(await check()).toBeNull();
});

it("a new build of the same version is an update, only when both builds are known", async () => {
  answer('{"version":"1.2.3","build":"b2"}');
  expect(await check("1.2.3", "b1")).toMatchObject({ version: "1.2.3", build: "b2" });
  expect(await check("1.2.3", "b2")).toBeNull();
  expect(await check("1.2.3")).toBeNull();
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
