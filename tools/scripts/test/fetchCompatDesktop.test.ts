import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasesNewestFirst } from "../compat-latest-release.mjs";
import { get, newestPublished, releaseFiles, tokenOf } from "../fetch-compat-desktop.mjs";

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

  it("gives up after 4 attempts, 2, 4 then 8 seconds apart, saying which URL and why", async () => {
    const fetch = vi.fn().mockRejectedValue(connectTimeout());
    vi.stubGlobal("fetch", fetch);
    const waits: number[] = [];
    await expect(get(url, (response) => response.text(), { sleep: async (ms: number) => { waits.push(ms); } })).rejects.toThrow(`GET ${url}: UND_ERR_CONNECT_TIMEOUT (4 attempts)`);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([2000, 4000, 8000]);
  });

  it("does not try again on a 403", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(get(url, (response) => response.text(), quick)).rejects.toThrow(`GET ${url}: 403`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the fetch script ends with status 1 and that reason in one line, not a stack, when GitHub never answers", () => {
    // No waits between the attempts here: the backoff is the test above's.
    const stub = `globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); };
      const setTimeout = globalThis.setTimeout; globalThis.setTimeout = (done, ms, ...rest) => setTimeout(done, ms >= 1000 ? 0 : ms, ...rest);`;
    const cache = mkdtempSync(join(tmpdir(), "compat-fetch-"));
    try {
      // PATH without gh: the anonymous download, whatever this machine's gh is logged in as.
      const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, resolve(import.meta.dirname, "../fetch-compat-desktop.mjs"), "--tag", "v9.9.9"], {
        env: { ...process.env, E2E_COMPAT_CACHE: cache, GH_TOKEN: "", GITHUB_TOKEN: "", PATH: "" }, encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      const lines = result.stderr.trim().split("\n");
      expect(lines.at(-1)).toMatch(/^fetch-compat-desktop\.mjs: GET https:\/\/github\.com\/MiguelMedeiros\/ghostly\/releases\/download\/v9\.9\.9\/\S+: UND_ERR_CONNECT_TIMEOUT \(4 attempts\)$/);
      expect(result.stderr).not.toMatch(/triggerUncaughtException|\n\s+at /);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("where the Desktop compatibility fetch downloads a release's files", () => {
  const token = "ghp_secretTokenNeverPrinted0123456789";
  const api = "https://api.github.com/repos/MiguelMedeiros/ghostly";
  const asset = (id: number, name: string) => ({ id, name, url: `${api}/releases/assets/${id}` });
  const release = { tag_name: "v1.10.3", assets: [asset(11, "SHA256SUMS.txt"), asset(12, "Ghostly_1.10.3_amd64.deb")] };
  const quick = { sleep: async () => {} };
  afterEach(() => vi.unstubAllGlobals());

  /** What each request asked for: its URL and its headers. */
  const requests = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url, init]) => ({ url: String(url), headers: new Headers(init?.headers) }));

  it("with a token, goes through the API's asset endpoint, the token in the Authorization header", async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith("/releases/tags/v1.10.3") ? Response.json(release) : new Response("abc123  Ghostly_1.10.3_amd64.deb\n")));
    vi.stubGlobal("fetch", fetch);
    expect(await releaseFiles({ token, ...quick }).sums("v1.10.3")).toBe("abc123  Ghostly_1.10.3_amd64.deb\n");
    const [byTag, file] = requests(fetch);
    expect(byTag.url).toBe(`${api}/releases/tags/v1.10.3`);
    expect(byTag.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(file.url).toBe(`${api}/releases/assets/11`);
    expect(file.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(file.headers.get("accept")).toBe("application/octet-stream");
  });

  it("with a token, reads the release once for its SHA256SUMS.txt and its package", async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith("/releases/tags/v1.10.3") ? Response.json(release) : new Response(url.endsWith("/12") ? "deb" : "sums")));
    vi.stubGlobal("fetch", fetch);
    const files = releaseFiles({ token, ...quick });
    expect(await files.sums("v1.10.3")).toBe("sums");
    expect(String(await files.download("v1.10.3", "Ghostly_1.10.3_amd64.deb"))).toBe("deb");
    expect(requests(fetch).map(({ url }) => url)).toEqual([`${api}/releases/tags/v1.10.3`, `${api}/releases/assets/11`, `${api}/releases/assets/12`]);
  });

  it("with a token, a release GitHub does not show (a draft) has no SHA256SUMS.txt, as anonymously", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await releaseFiles({ token, ...quick }).sums("v1.10.4")).toBeNull();
  });

  it("with a token, a release still uploading its files has no SHA256SUMS.txt yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ tag_name: "v1.10.4", assets: [] })));
    expect(await releaseFiles({ token, ...quick }).sums("v1.10.4")).toBeNull();
  });

  it("tries a 504 again and gets the file", async () => {
    const fetch = vi.fn(async (url: string) => (url.endsWith("/releases/tags/v1.10.3") ? Response.json(release) : new Response("deb")));
    fetch.mockResolvedValueOnce(Response.json(release)).mockResolvedValueOnce(new Response("", { status: 504 }));
    vi.stubGlobal("fetch", fetch);
    const log: string[] = [];
    expect(String(await releaseFiles({ token, ...quick, log: (line) => log.push(line) }).download("v1.10.3", "Ghostly_1.10.3_amd64.deb"))).toBe("deb");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log).toEqual([`GET ${api}/releases/assets/12: 504, trying again`]);
  });

  it("never says the token: not in the log, not in the error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`bad credentials for ${token}`, { status: 504 })));
    const log: string[] = [];
    const failed = await releaseFiles({ token, ...quick, log: (line) => log.push(line) }).sums("v1.10.3").catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toBe(`GET ${api}/releases/tags/v1.10.3: 504 (4 attempts)`);
    expect(log).toHaveLength(3);
    expect([...log, (failed as Error).message, String((failed as Error).stack)].join("\n")).not.toContain(token);
  });

  it("without a token, downloads the public URL, with no Authorization header", async () => {
    const fetch = vi.fn(async () => new Response("sums"));
    vi.stubGlobal("fetch", fetch);
    expect(await releaseFiles({ ...quick }).sums("v1.10.3")).toBe("sums");
    const [only] = requests(fetch);
    expect(only.url).toBe("https://github.com/MiguelMedeiros/ghostly/releases/download/v1.10.3/SHA256SUMS.txt");
    expect(only.headers.has("authorization")).toBe(false);
  });

  it("takes the token from GH_TOKEN, then GITHUB_TOKEN, then `gh auth token`, else none", () => {
    const gh = vi.fn(() => "gho_fromGh\n");
    expect(tokenOf({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }, gh)).toBe("a");
    expect(tokenOf({ GH_TOKEN: "", GITHUB_TOKEN: "b" }, gh)).toBe("b");
    expect(gh).not.toHaveBeenCalled();
    expect(tokenOf({}, gh)).toBe("gho_fromGh");
    expect(tokenOf({}, () => undefined)).toBeUndefined();
    expect(tokenOf({}, () => "")).toBeUndefined();
  });
});
