#!/usr/bin/env node
/**
 * Puts a published release's extension zip on the Chrome Web Store and submits it for review
 * (.github/workflows/chrome-web-store.yml), through the Chrome Web Store API V2 with a service account.
 *
 *   node tools/scripts/chrome-web-store.mjs credentials
 *       ready=true when CWS_SERVICE_ACCOUNT_JSON and CWS_PUBLISHER_ID are set; without them a notice and
 *       ready=false, exit 0: the workflow does nothing until the owner adds them (docs/RELEASING.md).
 *   node tools/scripts/chrome-web-store.mjs release <tag> < the release (gh api repos/<repo>/releases/tags/<tag>)
 *       go=true for a published vX.Y.Z release that is not a pre-release; otherwise a notice and go=false.
 *   node tools/scripts/chrome-web-store.mjs upload <tag> <zip>
 *       Uploads the zip to the item CWS_ITEM_ID and submits it, unless the store already has that version or a
 *       newer one, or is reviewing another one. Exits 1 when the store refuses something; the release is not
 *       touched either way.
 *
 * Outputs go to GITHUB_OUTPUT when it is set, annotations (::notice:: and the like) to stdout. The access token is
 * masked in the log before anything uses it; the service account's key is never printed.
 */
import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
export const ORIGINS = {
  api: "https://chromewebstore.googleapis.com",
  token: "https://oauth2.googleapis.com/token",
};
export const SECRETS = ["CWS_SERVICE_ACCOUNT_JSON", "CWS_PUBLISHER_ID"];

const RELEASE = /^v(\d+\.\d+\.\d+)$/;

/** The secrets of SECRETS that `env` lacks. */
export function missingCredentials(env) {
  return SECRETS.filter((name) => !env[name]?.trim());
}

/** Why the store must not get `tag`'s release, or null when it may. `release` is GitHub's release object, or null. */
export function releaseRefusal(tag, release) {
  if (!RELEASE.test(tag)) return `${tag} is not a release tag (vX.Y.Z)`;
  if (!release || release.tag_name !== tag) return `${tag} has no published release`;
  if (release.draft) return `${tag} is still a draft`;
  if (release.prerelease) return `${tag} is a pre-release`;
  return null;
}

/** -1, 0 or 1 as version `a` is before, the same as or after `b` (Chrome's 1 to 4 dotted numbers). */
export function compareVersions(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The `version` of the zip's manifest.json. */
export function manifestVersion(zip) {
  const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }));
  return String(manifest.version ?? "");
}

const base64url = (data) => Buffer.from(data).toString("base64url");

/** A signed JWT that asks Google for a Chrome Web Store access token as the service account (RFC 7523). */
export function serviceAccountAssertion(account, audience = ORIGINS.token, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: audience, iat, exp: iat + 600 }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), account.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** The service account key file's fields this needs. Never echoes the file: a refusal names the field only. */
export function parseServiceAccount(text) {
  let account;
  try {
    account = JSON.parse(text);
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_JSON is not JSON: paste the whole key file the Google Cloud console downloaded");
  }
  for (const field of ["client_email", "private_key"]) {
    if (typeof account?.[field] !== "string" || !account[field]) throw new Error(`CWS_SERVICE_ACCOUNT_JSON has no ${field}`);
  }
  return { client_email: account.client_email, private_key: account.private_key };
}

/** Google's error answer in one line: code, status, message and each detail (what failed in the package). */
function describeError(status, body) {
  const error = body?.error;
  if (typeof error === "string") return `HTTP ${status}: ${error}${body.error_description ? ` (${body.error_description})` : ""}`;
  if (!error) return `HTTP ${status}: ${typeof body === "string" ? body.slice(0, 2000) : JSON.stringify(body)}`;
  const details = (error.details ?? []).map((d) => JSON.stringify(d)).join("; ");
  return `HTTP ${status} ${error.status ?? ""}: ${error.message ?? ""}${details ? ` | details: ${details}` : ""}`.replace(/\s+:/, ":");
}

async function call(fetchImpl, url, init, what) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${what} failed: ${describeError(response.status, body)}`);
  return body;
}

/** The versions the store has for the item: published, and the one submitted for review with its state. */
export function storeState(status) {
  const versions = (revision) => (revision?.distributionChannels ?? []).map((c) => c.crxVersion).filter(Boolean);
  return {
    published: versions(status.publishedItemRevisionStatus),
    submitted: versions(status.submittedItemRevisionStatus),
    submittedState: status.submittedItemRevisionStatus?.state ?? null,
  };
}

/** Why `version` must not be uploaded given the store's state, as { level, why }, or null to go on. */
export function storeRefusal(version, state) {
  const newest = (list) => list.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), null);
  const published = newest(state.published);
  if (published && compareVersions(published, version) >= 0) return { level: "notice", why: `the store already publishes ${published}` };
  const submitted = newest(state.submitted);
  const waiting = state.submittedState === "PENDING_REVIEW" || state.submittedState === "STAGED";
  if (waiting && submitted && compareVersions(submitted, version) >= 0) {
    return { level: "notice", why: `the store already has ${submitted} submitted (${state.submittedState})` };
  }
  // A new package cannot go in while another one is in review. Cancelling that review would restart the wait at every
  // release, so the newer one waits: run the workflow again once the store has published (docs/RELEASING.md).
  if (waiting) return { level: "warning", why: `the store is reviewing ${submitted ?? "another version"} (${state.submittedState}); run this again once it is out` };
  return null;
}

/**
 * Upload `zip` (the release `tag`'s) to the item and submit it for review. Returns { outcome: "skipped" | "submitted",
 * why?, state? }; throws on any refusal, with Google's error in the message.
 */
export async function publish({ tag, zip, env, fetch: fetchImpl = fetch, origins = ORIGINS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 10_000, polls = 60, log = console.log, now = Date.now }) {
  const version = tag.replace(/^v/, "");
  const zipVersion = manifestVersion(zip);
  if (zipVersion !== version) throw new Error(`${basename(zip)}'s manifest says ${zipVersion || "no version"}, the release is ${tag}: nothing uploaded`);
  const missing = missingCredentials(env);
  if (missing.length) throw new Error(`${missing.join(" and ")} not set`);
  const item = env.CWS_ITEM_ID?.trim();
  if (!item) throw new Error("CWS_ITEM_ID not set");

  const account = parseServiceAccount(env.CWS_SERVICE_ACCOUNT_JSON);
  const grant = await call(
    fetchImpl,
    origins.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(account, origins.token, now()) }).toString(),
    },
    "Getting an access token for the service account",
  );
  const token = grant.access_token;
  if (!token) throw new Error("Getting an access token for the service account failed: no access_token in the answer");
  log(`::add-mask::${token}`);

  const name = `publishers/${env.CWS_PUBLISHER_ID.trim()}/items/${item}`;
  const auth = { Authorization: `Bearer ${token}` };
  const fetchStatus = () => call(fetchImpl, `${origins.api}/v2/${name}:fetchStatus`, { headers: auth }, "Reading the item's status");

  const status = await fetchStatus();
  if (status.takenDown) log("::warning::The store says the item was taken down for a policy violation: see the Developer Dashboard");
  else if (status.warned) log("::warning::The store has a policy warning on the item: see the Developer Dashboard");
  const state = storeState(status);
  log(`Store: published ${state.published.join(", ") || "none"}; submitted ${state.submitted.join(", ") || "none"}${state.submittedState ? ` (${state.submittedState})` : ""}`);
  const refusal = storeRefusal(version, state);
  if (refusal) {
    log(`::${refusal.level}::Chrome Web Store: ${version} not uploaded: ${refusal.why}`);
    return { outcome: "skipped", why: refusal.why };
  }

  log(`Uploading ${basename(zip)} (${version}) to ${item}`);
  const upload = await call(
    fetchImpl,
    `${origins.api}/upload/v2/${name}:upload`,
    { method: "POST", headers: { ...auth, "Content-Type": "application/zip", "X-Goog-Upload-Protocol": "raw", "X-Goog-Upload-File-Name": basename(zip) }, body: readFileSync(zip) },
    "Uploading the zip",
  );
  let uploadState = upload.uploadState;
  let last = upload;
  for (let i = 0; uploadState === "IN_PROGRESS" && i < polls; i++) {
    await sleep(pollMs);
    last = await fetchStatus();
    log(`Upload: ${last.lastAsyncUploadState}`);
    // NOT_FOUND right after an upload: the store has not listed it yet.
    uploadState = last.lastAsyncUploadState === "NOT_FOUND" ? "IN_PROGRESS" : last.lastAsyncUploadState;
  }
  if (uploadState === "IN_PROGRESS") throw new Error(`The store is still processing the upload after ${Math.round((polls * pollMs) / 1000)} s: check the Developer Dashboard, then run this again`);
  if (uploadState !== "SUCCEEDED") throw new Error(`The store refused the upload (${uploadState ?? "no state"}): ${JSON.stringify(last)}`);
  if (upload.crxVersion && upload.crxVersion !== version) throw new Error(`The store read version ${upload.crxVersion} from the upload, not ${version}`);

  const submitted = await call(
    fetchImpl,
    `${origins.api}/v2/${name}:publish`,
    { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }) },
    "Submitting it for review",
  );
  for (const warning of submitted.warningInfo?.warnings ?? []) log(`::warning::Chrome Web Store: ${JSON.stringify(warning)}`);
  log(`::notice::Chrome Web Store: ${version} submitted for review (${submitted.state ?? "no state"})`);
  return { outcome: "submitted", state: submitted.state ?? null };
}

function output(line) {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function main([command, ...args]) {
  if (command === "credentials") {
    const missing = missingCredentials(process.env);
    if (missing.length) {
      const why = `Chrome Web Store upload not set up: the chrome-web-store environment has no ${missing.join(" or ")} secret (docs/RELEASING.md, "Chrome Web Store"). Nothing was uploaded.`;
      console.log(`::notice::${why}`);
      summary(why);
    }
    output(`ready=${missing.length ? "false" : "true"}`);
    return 0;
  }
  if (command === "release") {
    const [tag = ""] = args;
    let release = null;
    try {
      release = JSON.parse(readFileSync(0, "utf8") || "null");
    } catch {
      release = null;
    }
    const why = releaseRefusal(tag, release);
    if (why) {
      console.log(`::notice::Chrome Web Store: nothing to upload: ${why}`);
      summary(`Nothing uploaded to the Chrome Web Store: ${why}.`);
    }
    output(`go=${why ? "false" : "true"}`);
    return 0;
  }
  if (command === "upload") {
    const [tag = "", zip = ""] = args;
    try {
      const result = await publish({ tag, zip, env: process.env });
      summary(result.outcome === "submitted" ? `${tag} submitted to the Chrome Web Store for review (${result.state}).` : `${tag} not uploaded to the Chrome Web Store: ${result.why}.`);
      return 0;
    } catch (error) {
      console.log(`::error::${error.message}`);
      summary(`Chrome Web Store upload of ${tag} failed: ${error.message}`);
      return 1;
    }
  }
  console.error("usage: chrome-web-store.mjs credentials | release <tag> < release.json | upload <tag> <zip>");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
