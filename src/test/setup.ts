import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach } from "vitest";
import { fakeEngine, installFakeEngine } from "./fakeEngine";

beforeAll(installFakeEngine);

beforeEach(() => {
  // Settings, the chosen payment card and the rest of what the UI keeps live in this origin's storage.
  localStorage.clear();
  delete document.documentElement.dataset.reduceMotion;
  fakeEngine.reset();
});

afterEach(cleanup);
