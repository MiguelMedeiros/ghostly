import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createContext, runInContext, type Context } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { MacDriver } from "../../../e2e/support/desktopMac";

/*
 * `MacDriver.reload` (e2e/support/desktopMac.ts), against a driver that answers `POST /eval` as the app's does
 * (apps/desktop/src/e2e_driver.rs), with a page that is a `node:vm` context. A reload here does what WKWebView does: the
 * document that asked for it goes on answering, `complete`, for a moment, then a new one loads. A script started in
 * that moment is lost with the old document, which is how `desktop-macos/device-signing-key.spec.ts` waited two
 * minutes for an answer nobody held any more.
 */

/** How long the old document goes on answering after `location.reload()`, and how long the new one loads. */
const COMMIT_MS = 300;
const LOAD_MS = 200;

let server: Server | undefined;
afterEach(async () => {
  await new Promise((done) => server?.close(done) ?? done(null));
  server = undefined;
});

async function fakeDriver(): Promise<{ driver: MacDriver; documents: () => number }> {
  let documents = 0;
  let page: Context;
  const open = (readyState: string) => {
    documents += 1;
    const document = { readyState };
    const window: Record<string, unknown> = { document };
    window.window = window;
    window.location = {
      reload: () => setTimeout(() => {
        const next = open("loading");
        setTimeout(() => { next.readyState = "complete"; }, LOAD_MS);
      }, COMMIT_MS),
    };
    page = createContext(window);
    return document;
  };
  open("complete");

  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { script } = JSON.parse(body) as { script: string };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(runInContext(script, page)));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { driver: new MacDriver(`http://127.0.0.1:${port}`, "token"), documents: () => documents };
}

describe("MacDriver.reload", () => {
  it("answers once the new document has loaded, not while the old one still says complete", async () => {
    const { driver, documents } = await fakeDriver();
    await driver.execute(`window.before = "the old document";`);

    await driver.reload();

    expect(documents()).toBe(2);
    expect(await driver.execute(`return { state: document.readyState, before: window.before ?? null };`)).toEqual({ state: "complete", before: null });
  });

  it("a script started after it finishes in the new document", async () => {
    const { driver } = await fakeDriver();

    await driver.reload();

    expect(await driver.executeAsync(`const done = arguments[arguments.length - 1]; Promise.resolve("signed").then(done);`)).toBe("signed");
  });

  it("says so when no new document comes", async () => {
    const { driver } = await fakeDriver();
    await driver.execute(`window.location.reload = () => {};`);

    await expect(driver.reload(400)).rejects.toThrow("The page did not reload");
  });
});
