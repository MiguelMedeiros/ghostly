import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compareVersions, publish, releaseRefusal, SCOPE, storeRefusal, storeState } from "../chrome-web-store.mjs";

/**
 * The Chrome Web Store upload (chrome-web-store.yml, tools/scripts/chrome-web-store.mjs) against a fake of the API V2:
 * its token endpoint, fetchStatus, upload and publish, answering with the shapes Google documents. No request leaves
 * the machine, and the service account is a key made here for the test.
 */
const root = resolve(import.meta.dirname, "../../..");
const script = resolve(root, "tools/scripts/chrome-web-store.mjs");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

const PUBLISHER = "publisher-1";
const ITEM = "nbedaagicniejlmfcncndfjcejaidbcf";
const NAME = `publishers/${PUBLISHER}/items/${ITEM}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "cws-upload@ghostly-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
});
const TOKEN = "fake-access-token-123";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cws-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A zip like release.yml's: the extension's dist folder, manifest.json at its root. */
function zip(version: string): string {
  const src = join(dir, `dist-${version}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Ghostly", version }));
  writeFileSync(join(src, "index.html"), "<!doctype html>");
  const out = join(dir, `ghostly-browser-extension-${version}.zip`);
  rmSync(out, { force: true });
  execFileSync("zip", ["-qr", out, "."], { cwd: src });
  return out;
}

type Answer = { status?: number; body: unknown };
type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: Buffer };

/** The fake API: each path answers from its own list in turn (the last answer repeats), and every request is kept. */
class FakeStore {
  seen: Seen[] = [];
  answers = new Map<string, Answer[]>();
  server!: Server;
  origin = "";

  on(path: string, ...answers: Answer[]) {
    this.answers.set(path, answers);
    return this;
  }

  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const path = (req.url ?? "").split("?")[0];
        this.seen.push({ method: req.method ?? "", path, headers: req.headers, body: Buffer.concat(chunks) });
        const list = this.answers.get(path) ?? [{ status: 404, body: { error: { code: 404, message: `no fake for ${path}`, status: "NOT_FOUND" } } }];
        const answer = list.length > 1 ? list.shift()! : list[0];
        res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  paths() {
    return this.seen.map((s) => `${s.method} ${s.path}`);
  }
}

const STATUS = `/v2/${NAME}:fetchStatus`;
const UPLOAD = `/upload/v2/${NAME}:upload`;
const PUBLISH = `/v2/${NAME}:publish`;
const published = (crxVersion: string) => ({ name: NAME, itemId: ITEM, publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ deployPercentage: 100, crxVersion }] } });
const tokenAnswer: Answer = { body: { access_token: TOKEN, expires_in: 3599, token_type: "Bearer" } };

let store: FakeStore;
afterEach(async () => {
  await store?.stop();
});

async function run(tag: string, file: string, env: Record<string, string> = {}) {
  const log: string[] = [];
  const result = await publish({
    tag,
    zip: file,
    env: { CWS_SERVICE_ACCOUNT_JSON: ACCOUNT, CWS_PUBLISHER_ID: PUBLISHER, CWS_ITEM_ID: ITEM, ...env },
    origins: { api: store.origin, token: `${store.origin}/token` },
    sleep: async () => {},
    pollMs: 1,
    polls: 5,
    log: (line: string) => log.push(line),
  }).catch((error: Error) => ({ outcome: "failed", error: error.message }));
  return { result, log };
}

describe("the store upload, against a fake Chrome Web Store API", () => {
  it("uploads a newer version, waits while the store processes it, then submits it for review", async () => {
    store = await new FakeStore()
      .on("/token", tokenAnswer)
      .on(
        STATUS,
        { body: published("1.1.6") },
        { body: { ...published("1.1.6"), lastAsyncUploadState: "NOT_FOUND" } },
        { body: { ...published("1.1.6"), lastAsyncUploadState: "IN_PROGRESS" } },
        { body: { ...published("1.1.6"), lastAsyncUploadState: "SUCCEEDED" } },
      )
      .on(UPLOAD, { body: { name: NAME, itemId: ITEM, uploadState: "IN_PROGRESS" } })
      .on(PUBLISH, { body: { name: NAME, itemId: ITEM, state: "PENDING_REVIEW" } })
      .start();
    const file = zip("1.8.1");
    const { result, log } = await run("v1.8.1", file);

    expect(result).toEqual({ outcome: "submitted", state: "PENDING_REVIEW" });
    expect(store.paths()).toEqual([`POST /token`, `GET ${STATUS}`, `POST ${UPLOAD}`, `GET ${STATUS}`, `GET ${STATUS}`, `GET ${STATUS}`, `POST ${PUBLISH}`]);
    // The token is masked before anything uses it.
    expect(log[0]).toBe(`::add-mask::${TOKEN}`);
    expect(log.join("\n")).not.toContain("PRIVATE KEY");
    expect(log.at(-1)).toBe("::notice::Chrome Web Store: 1.8.1 submitted for review (PENDING_REVIEW)");

    const [token, status, upload, , , , submit] = store.seen;
    // A JWT signed with the service account's key, for the store's scope, exchanged at the token endpoint.
    const form = new URLSearchParams(token.body.toString());
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(payload).toMatchObject({ iss: "cws-upload@ghostly-test.iam.gserviceaccount.com", scope: SCOPE, aud: `${store.origin}/token` });
    expect(payload.exp - payload.iat).toBe(600);

    expect(status.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The zip itself, byte for byte, as a raw upload.
    expect(upload.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(upload.headers["x-goog-upload-protocol"]).toBe("raw");
    expect(upload.body.equals(readFileSync(file))).toBe(true);
    // Submitted for review, published once approved: no skipReview, no staging.
    expect(JSON.parse(submit.body.toString())).toEqual({ publishType: "DEFAULT_PUBLISH" });
  });

  it("uploads nothing when the store already publishes that version or a newer one", async () => {
    store = await new FakeStore().on("/token", tokenAnswer).on(STATUS, { body: published("1.8.1") }).start();
    const same = await run("v1.8.1", zip("1.8.1"));
    expect(same.result).toEqual({ outcome: "skipped", why: "the store already publishes 1.8.1" });
    expect(same.log).toContain("::notice::Chrome Web Store: 1.8.1 not uploaded: the store already publishes 1.8.1");

    const older = await run("v1.7.5", zip("1.7.5"));
    expect(older.result).toEqual({ outcome: "skipped", why: "the store already publishes 1.8.1" });
    expect(store.paths().filter((p) => p.includes(":upload") || p.includes(":publish"))).toEqual([]);
  });

  it("uploads nothing while the store reviews a submission, and says to run it again", async () => {
    store = await new FakeStore()
      .on("/token", tokenAnswer)
      .on(STATUS, { body: { ...published("1.1.6"), submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ deployPercentage: 100, crxVersion: "1.8.0" }] } } })
      .start();
    const { result, log } = await run("v1.8.1", zip("1.8.1"));
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(log).toContain("::warning::Chrome Web Store: 1.8.1 not uploaded: the store is reviewing 1.8.0 (PENDING_REVIEW); run this again once it is out");
    expect(store.paths()).toEqual([`POST /token`, `GET ${STATUS}`]);
  });

  it("fails with the store's own words when the upload fails, and submits nothing", async () => {
    store = await new FakeStore()
      .on("/token", tokenAnswer)
      .on(STATUS, { body: published("1.1.6") }, { body: { ...published("1.1.6"), lastAsyncUploadState: "FAILED" } })
      .on(UPLOAD, { body: { name: NAME, itemId: ITEM, uploadState: "IN_PROGRESS" } })
      .start();
    const failed = await run("v1.8.1", zip("1.8.1"));
    expect(failed.result).toMatchObject({ outcome: "failed", error: expect.stringContaining("The store refused the upload (FAILED)") });
    expect(store.paths()).not.toContain(`POST ${PUBLISH}`);

    await store.stop();
    const refusal = { error: { code: 400, status: "INVALID_ARGUMENT", message: "The manifest version must be greater than the published one.", details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "manifest.version" }] }] } };
    store = await new FakeStore().on("/token", tokenAnswer).on(STATUS, { body: published("1.1.6") }).on(UPLOAD, { status: 400, body: refusal }).start();
    const refused = await run("v1.8.1", zip("1.8.1"));
    expect(refused.result).toMatchObject({ outcome: "failed" });
    const error = (refused.result as { error: string }).error;
    expect(error).toContain("Uploading the zip failed: HTTP 400 INVALID_ARGUMENT: The manifest version must be greater than the published one.");
    expect(error).toContain('"field":"manifest.version"');
    expect(store.paths()).not.toContain(`POST ${PUBLISH}`);
  });

  it("fails on a refused token or submission, never printing the key", async () => {
    store = await new FakeStore().on("/token", { status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } }).start();
    const token = await run("v1.8.1", zip("1.8.1"));
    expect((token.result as { error: string }).error).toBe("Getting an access token for the service account failed: HTTP 400: invalid_grant (Invalid JWT Signature.)");
    expect(JSON.stringify(token)).not.toContain("PRIVATE KEY");

    await store.stop();
    store = await new FakeStore()
      .on("/token", tokenAnswer)
      .on(STATUS, { body: published("1.1.6") })
      .on(UPLOAD, { body: { name: NAME, itemId: ITEM, crxVersion: "1.8.1", uploadState: "SUCCEEDED" } })
      .on(PUBLISH, { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } } })
      .start();
    const submit = await run("v1.8.1", zip("1.8.1"));
    expect((submit.result as { error: string }).error).toBe("Submitting it for review failed: HTTP 403 PERMISSION_DENIED: The caller does not have permission");
  });

  it("uploads nothing when the zip's manifest is not the release's version, or the key is not a key file", async () => {
    store = await new FakeStore().on("/token", tokenAnswer).start();
    const mismatch = await run("v1.8.1", zip("1.8.0"));
    expect((mismatch.result as { error: string }).error).toBe("ghostly-browser-extension-1.8.0.zip's manifest says 1.8.0, the release is v1.8.1: nothing uploaded");
    const notJson = await run("v1.8.1", zip("1.8.1"), { CWS_SERVICE_ACCOUNT_JSON: "{ private_key: secret-material" });
    expect((notJson.result as { error: string }).error).toMatch(/^CWS_SERVICE_ACCOUNT_JSON is not JSON/);
    expect(JSON.stringify(notJson)).not.toContain("secret-material");
    expect(store.seen).toEqual([]);
  });
});

describe("what the store gets", () => {
  it("only a published vX.Y.Z release that is not a pre-release", () => {
    const release = (over = {}) => ({ tag_name: "v1.8.1", draft: false, prerelease: false, ...over });
    expect(releaseRefusal("v1.8.1", release())).toBeNull();
    expect(releaseRefusal("v1.8.1", null)).toBe("v1.8.1 has no published release");
    expect(releaseRefusal("v1.8.1", release({ draft: true }))).toBe("v1.8.1 is still a draft");
    expect(releaseRefusal("v1.9.0-beta.1", release({ tag_name: "v1.9.0-beta.1", prerelease: true }))).toMatch(/not a release tag/);
    expect(releaseRefusal("v1.8.1", release({ prerelease: true }))).toBe("v1.8.1 is a pre-release");
    expect(releaseRefusal("translation-runtime-v1.2.0", release({ tag_name: "translation-runtime-v1.2.0", prerelease: true }))).toMatch(/not a release tag/);
  });

  it("compares Chrome versions by number", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.8.0", "1.8.0.0")).toBe(0);
    expect(compareVersions("1.1.6", "1.8.1")).toBe(-1);
  });

  it("goes on after a rejected or cancelled submission", () => {
    const state = storeState({ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: "1.1.6" }] }, submittedItemRevisionStatus: { state: "REJECTED", distributionChannels: [{ crxVersion: "1.8.0" }] } });
    expect(storeRefusal("1.8.1", state)).toBeNull();
    expect(storeRefusal("1.8.1", { ...state, submittedState: "CANCELLED" })).toBeNull();
    expect(storeRefusal("1.8.1", { ...state, submittedState: "PENDING_REVIEW", submitted: ["1.8.1"] })).toEqual({ level: "notice", why: "the store already has 1.8.1 submitted (PENDING_REVIEW)" });
  });
});

describe("the workflow's steps, as the runner calls the script", () => {
  const cli = (args: string[], env: Record<string, string>, input = "") => {
    const out = join(dir, `output-${Math.random()}`);
    writeFileSync(out, "");
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CWS_") && !k.startsWith("GITHUB_")));
    const child = spawnSync("node", [script, ...args], { env: { ...clean, GITHUB_OUTPUT: out, ...env }, input, encoding: "utf8" });
    return { status: child.status, stdout: child.stdout, output: readFileSync(out, "utf8") };
  };

  it("without the secrets: a notice, ready=false, exit 0", () => {
    const none = cli(["credentials"], {});
    expect(none.status).toBe(0);
    expect(none.output).toBe("ready=false\n");
    expect(none.stdout).toContain("::notice::Chrome Web Store upload not set up: the repository has no CWS_SERVICE_ACCOUNT_JSON or CWS_PUBLISHER_ID secret");
    const half = cli(["credentials"], { CWS_SERVICE_ACCOUNT_JSON: "set" });
    expect(half.output).toBe("ready=false\n");
    expect(half.stdout).toContain("no CWS_PUBLISHER_ID secret");
    expect(cli(["credentials"], { CWS_SERVICE_ACCOUNT_JSON: "set", CWS_PUBLISHER_ID: "set" }).output).toBe("ready=true\n");
  });

  it("a draft (no release by tag), a pre-release or a stray tag: a notice, go=false, exit 0", () => {
    const ok = cli(["release", "v1.8.1"], {}, JSON.stringify({ tag_name: "v1.8.1", draft: false, prerelease: false }));
    expect(ok).toMatchObject({ status: 0, output: "go=true\n" });
    const draft = cli(["release", "v1.8.1"], {}, "null\n");
    expect(draft).toMatchObject({ status: 0, output: "go=false\n" });
    expect(draft.stdout).toContain("::notice::Chrome Web Store: nothing to upload: v1.8.1 has no published release");
    expect(cli(["release", "translation-runtime-v1.2.0"], {}, JSON.stringify({ tag_name: "translation-runtime-v1.2.0", prerelease: true }))).toMatchObject({ status: 0, output: "go=false\n" });
  });

  it("a failed upload fails the step with an error annotation", () => {
    const failed = cli(["upload", "v1.8.1", zip("1.8.0")], { CWS_SERVICE_ACCOUNT_JSON: ACCOUNT, CWS_PUBLISHER_ID: PUBLISHER, CWS_ITEM_ID: ITEM });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("::error::ghostly-browser-extension-1.8.0.zip's manifest says 1.8.0, the release is v1.8.1: nothing uploaded");
    expect(failed.stdout).not.toContain("PRIVATE KEY");
  });
});

describe("chrome-web-store.yml", () => {
  const workflow = read(".github/workflows/chrome-web-store.yml");
  const steps = workflow.slice(workflow.indexOf("    steps:\n")).split(/^ {6}- /m).slice(1);
  const step = (name: string) => steps.find((s) => s.startsWith(`name: ${name}\n`)) ?? "";

  it("runs on a published release or by hand, in a workflow of its own: the release never waits on the store", () => {
    expect(workflow).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(read(".github/workflows/release.yml")).not.toContain("chrome-web-store");
    expect(workflow).toContain("CWS_ITEM_ID: nbedaagicniejlmfcncndfjcejaidbcf");
  });

  it("does nothing past the credentials step until both secrets exist, and the step before it sees no secret", () => {
    const names = steps.map((s) => /^name: (.*)$/m.exec(s)?.[1]);
    expect(names).toEqual(["Checkout", "Store credentials", "Published release", "Download the extension zip", "Upload and submit for review"]);
    expect(steps[0]).not.toContain("secrets.");
    expect(step("Store credentials")).toContain("${{ secrets.CWS_SERVICE_ACCOUNT_JSON != '' && 'set' || '' }}");
    expect(step("Store credentials")).toContain("node tools/scripts/chrome-web-store.mjs credentials");
    for (const later of steps.slice(2)) expect(later).toMatch(/^ {8}if: steps\.credentials\.outputs\.ready == 'true'/m);
    for (const later of steps.slice(3)) expect(later).toContain("steps.release.outputs.go == 'true'");
    // The secrets' values reach the upload step only.
    const withValues = steps.filter((s) => /secrets\.CWS_[A-Z_]+ \}\}/.test(s)).map((s) => /^name: (.*)$/m.exec(s)?.[1]);
    expect(withValues).toEqual(["Upload and submit for review"]);
    expect(workflow).not.toMatch(/echo[^\n]*CWS_SERVICE_ACCOUNT_JSON/);
  });
});
