import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { fakeEngine, installFakeEngine } from "./fakeEngine";

// The web app's session sync (started by the sidebar) keeps localStorage and the peer in step on every state push:
// it would call the fake engine behind the test's back for the rest of the file. A test about it can unmock it.
vi.mock("@ghostly/browser/platform/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghostly/browser/platform/sync")>()),
  startSessionSync: () => {},
}));

beforeAll(installFakeEngine);

beforeEach(() => {
  // Settings, the chosen payment card and the rest of what the UI keeps live in this origin's storage.
  localStorage.clear();
  delete document.documentElement.dataset.reduceMotion;
  fakeEngine.reset();
});

afterEach(cleanup);
