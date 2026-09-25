import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { resetGifSearch } from "../lib/gifSearch";
import { fakeEngine, installFakeEngine } from "./fakeEngine";

// The web app's session sync (started by the sidebar) keeps localStorage and the peer in step on every state push:
// it would call the fake engine behind the test's back for the rest of the file. A test about it can unmock it.
vi.mock("@ghostly/browser/platform/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghostly/browser/platform/sync")>()),
  startSessionSync: () => {},
}));

beforeAll(installFakeEngine);

// No test reaches the Internet Archive. GifCities limits requests per IP (with a 200 HTML page), and our own test runs
// share the IPs people use: a test that opens the GIF panel mocks fetch (`gifCities` in chat/composer.test.tsx). One
// that forgets is refused here, and fails after it, rather than asking the real GifCities or the Wayback Machine.
const archiveAsked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/([^/?#]*\.)?archive\.org([/:?#]|$)/i.test(url)) {
    archiveAsked.push(url);
    return Promise.reject(new TypeError(`${url}: tests must not reach the Internet Archive; mock fetch`));
  }
  return realFetch(input, init);
}) as typeof fetch;

beforeEach(() => {
  // Settings, the chosen payment card and the rest of what the UI keeps live in this origin's storage.
  localStorage.clear();
  sessionStorage.clear();
  // GIF answers and the rate-limit wait are kept for the app session: each test starts a session of its own.
  resetGifSearch();
  delete document.documentElement.dataset.reduceMotion;
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
  fakeEngine.reset();
});

afterEach(() => {
  cleanup();
  const asked = archiveAsked.splice(0);
  expect(asked, "requests that would have reached the Internet Archive").toEqual([]);
});
