import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasesNewestFirst } from "../compat-latest-release.mjs";
import { get, newestPublished } from "../fetch-compat-desktop.mjs";

/** A release's SHA256SUMS.txt with its Linux package. */
const sums = (tag: string) => `abc123  Ghostly_${tag.slice(1)}_amd64.deb\ndef456  Ghostly_${tag.slice(1)}_aarch64.dmg\n`;

/** Releases as GitHub serves them anonymously: a published one's SHA256SUMS.txt, a draft's none (404). */
const served = (published: Record<string, string>) => async (tag: string) => published[tag] ?? null;

describe("the newest release the Desktop compatibility e2e fetches", () => {
  it("is the newest tag when its release is published", async () => {
    const found = await newestPublished(["v1.7.3", "v1.7.2"], served({ "v1.7.3": sums("v1.7.3"), "v1.7.2": sums("v1.7.2") }));
    expect(found).toEqual({ tag: "v1.7.3", sums: sums("v1.7.3") });
  });

  it("is the release before when the newest tag's release is still a draft, which has no public package", async () => {
    const log: string[] = [];
    const found = await newestPublished(["v1.7.3", "v1.7.2"], served({ "v1.7.2": sums("v1.7.2") }), (line) => log.push(line));
    expect(found?.tag).toBe("v1.7.2");
    expect(log).toEqual(["v1.7.3 has no published release (a draft, or still building): trying the release before it"]);
  });

  it("passes over a published release that attaches no Linux package", async () => {
    const found = await newestPublished(["v1.7.3", "v1.7.2"], served({ "v1.7.3": "abc123  Ghostly_1.7.3_aarch64.dmg\n", "v1.7.2": sums("v1.7.2") }));
    expect(found?.tag).toBe("v1.7.2");
  });

  it("is nothing when no release publishes its package", async () => {
    expect(await newestPublished(["v1.7.3"], served({}))).toBeNull();
  });

  it("walks the tags newest first, leaving out the commit under test", () => {
    const lsRemote = "a\trefs/tags/v1.7.3\nb\trefs/tags/v1.10.0\nc\trefs/tags/v1.7.2\nd\trefs/tags/v1.8.0-beta.1\n";
    expect(releasesNewestFirst(lsRemote, "b")).toEqual(["v1.7.3", "v1.7.2"]);
  });

  it("is what the Desktop spec runs against, beside v1.1.5", () => {
    const spec = readFileSync(resolve(import.meta.dirname, "../../../e2e/desktop/compat.spec.ts"), "utf8");
    expect(spec).toContain('release: process.env.E2E_COMPAT_LATEST || "newest"');
    expect(spec).toContain('release: "v1.1.5"');
  });
});

/** What undici throws when github.com does not answer the connect in time. */
const connectTimeout = () => Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error("Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
});

describe("a request of the Desktop compatibility fetch", () => {
  const url = "https://github.com/MiguelMedeiros/ghostly/releases/download/v1.7.3/SHA256SUMS.txt";
  const quick = { sleep: async () => {} };
  afterEach(() => vi.unstubAllGlobals());

  it("tries again after a connect timeout, and gets the file", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(connectTimeout()).mockResolvedValue(new Response("abc123  Ghostly_1.7.3_amd64.deb\n"));
    vi.stubGlobal("fetch", fetch);
    const log: string[] = [];
    expect(await get(url, (response) => response.text(), { ...quick, log: (line) => log.push(line) })).toBe("abc123  Ghostly_1.7.3_amd64.deb\n");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toEqual([`GET ${url}: UND_ERR_CONNECT_TIMEOUT, trying again`]);
  });

  it("tries again after a 5xx, but takes a 404 as the answer", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 502 })).mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    expect(await get(url, (response) => response.status, quick)).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 attempts, saying which URL and why", async () => {
    const fetch = vi.fn().mockRejectedValue(connectTimeout());
    vi.stubGlobal("fetch", fetch);
    await expect(get(url, (response) => response.text(), quick)).rejects.toThrow(`GET ${url}: UND_ERR_CONNECT_TIMEOUT (3 attempts)`);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not try again on a 403", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(get(url, (response) => response.text(), quick)).rejects.toThrow(`GET ${url}: 403`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the fetch script ends with status 1 and that reason in one line, not a stack, when GitHub never answers", () => {
    const stub = `globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); };`;
    const cache = mkdtempSync(join(tmpdir(), "compat-fetch-"));
    try {
      const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, resolve(import.meta.dirname, "../fetch-compat-desktop.mjs"), "--tag", "v9.9.9"], {
        env: { ...process.env, E2E_COMPAT_CACHE: cache }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      const lines = result.stderr.trim().split("\n");
      expect(lines.at(-1)).toMatch(/^fetch-compat-desktop\.mjs: GET https:\/\/github\.com\/MiguelMedeiros\/ghostly\/releases\/download\/v9\.9\.9\/\S+: UND_ERR_CONNECT_TIMEOUT \(3 attempts\)$/);
      expect(result.stderr).not.toMatch(/triggerUncaughtException|\n\s+at /);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 30_000);
});
