import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIPBOARD_GUARD_HASH, CLIPBOARD_GUARD_SCRIPT, VIEWER_GUARD_CSP } from "@ghostly/core";
import type { FakeWorld } from "./fakeChrome";
import { okResponse, engineControl, resetEngine } from "./fakeEngine";
import { PEER, SERVICE, TAG, bodyText, bootExtension, openViewer, pauseRequest } from "./extension";

// covers: services.open

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

let world: FakeWorld;
let tabId: number;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
  tabId = await openViewer(world);
});

const url = `https://${SERVICE}.${PEER}.${TAG}.invalid/`;
const GUARD = `<script>${CLIPBOARD_GUARD_SCRIPT}</script>`;

/** What the tab gets for `body` with `headers`, asked for as `resourceType`. */
async function served(body: string, headers: [string, string][], resourceType = "Document", path = "") {
  engineControl().respond = async () => okResponse(body, 200, headers);
  const { params } = await pauseRequest(world, tabId, { url: url + path }, resourceType);
  const list = params.responseHeaders as { name: string; value: string }[];
  const policies = list.filter(({ name }) => name.toLowerCase() === "content-security-policy").map(({ value }) => value);
  return { body: bodyText(params), headers: list, policy: policies.join(", "), policies };
}

describe("a contact's app's page in its tab", () => {
  it("runs the clipboard guard before anything of the app's, which no policy of the contact's refuses", async () => {
    // Chromium lets `execCommand("copy")` write for seconds after a tap, from a timer too: `clipboard-write=()` does not
    // reach it, nor does the sandbox.
    const page = await served("<!doctype html><html><script>setTimeout(() => document.execCommand('copy'), 1500)</script>", [["content-type", "text/html; charset=utf-8"], ["content-security-policy", "script-src 'self'"]]);
    expect(page.body).toBe(`<!doctype html>${GUARD}<html><script>setTimeout(() => document.execCommand('copy'), 1500)</script>`);
    expect(page.policy).toContain(`script-src 'self' ${CLIPBOARD_GUARD_HASH}`);
    expect(page.policy).toContain(VIEWER_GUARD_CSP);
    expect(page.headers.some(({ name }) => name.toLowerCase() === "content-length")).toBe(false);
    // One header, Ghostly's sandbox last: the guard is a script of the page's own origin and runs under it.
    expect(page.policies).toHaveLength(1);
    expect(page.policy.endsWith("; sandbox allow-scripts allow-same-origin allow-forms")).toBe(true);
  });

  it("runs it in a frame's page and in an <object>'s too", async () => {
    expect((await served("<p>frame</p>", [["content-type", "text/html"]], "Document", "frame")).body).toBe(`${GUARD}<p>frame</p>`);
    expect((await served("<p>object</p>", [["content-type", "text/html"]], "Other", "object")).body).toBe(`${GUARD}<p>object</p>`);
  });

  it.each([
    ["compressed", [["content-type", "text/html"], ["content-encoding", "gzip"]], "Document"],
    ["UTF-16", [["content-type", "text/html; charset=utf-16le"]], "Document"],
    // A tab's own page of these is the error page (`shownAsPage`); an <object> of the app's shows it.
    ["of a type a browser may read as HTML", [["content-type", "application/unknown"]], "Other"],
    ["of no type", [], "Other"],
  ] as [string, [string, string][], string][])("runs no script at all when %s, where the guard cannot go first", async (_, headers, resourceType) => {
    const page = await served("<script>document.execCommand('copy')</script>", headers, resourceType);
    expect(page.body).toBe("<script>document.execCommand('copy')</script>");
    expect(page.policy).toContain("script-src 'none'");
  });

  it("leaves what is no page as it was: a script, a style, an XHR's answer, a worker's own script", async () => {
    for (const [resourceType, type] of [["Script", "text/javascript"], ["Stylesheet", "text/css"], ["XHR", "text/html"], ["Fetch", "application/json"], ["Other", "text/javascript"]]) {
      const answer = await served("console.log(1)", [["content-type", type]], resourceType, "x");
      expect(answer.body).toBe("console.log(1)");
      expect(answer.policy).not.toContain("script-src 'none'");
      // A worker has no `javascript:` URL to keep: Trusted Types there would refuse its every `importScripts`.
      if (resourceType === "Other") expect(answer.policy).not.toContain("require-trusted-types-for");
    }
  });
});
