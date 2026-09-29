import { describe, expect, it } from "vitest";
import { mayReach } from "../src/engine/serviceAccess";
import type { StoredService } from "../src/shared/types";
// covers: services.http, services.share

const base: StoredService = { id: "atlas", name: "Atlas", target: "http://localhost:3400", enabled: true, createdAt: 0 };
const alice = "mw5tk8941qa71k7ndjsu3xdftuc7aced7xbm37empy4m31xq76dy";
const bob = "y4hhd9ibxsdf8pmpiofxcuwgqnnf81okiujkahyb1ndrfg8ejkmc";

describe("who may reach a shared web app", () => {
  it("reaches nobody until a contact is granted it by name", () => {
    expect(mayReach(base, alice)).toBe(false);
    expect(mayReach({ ...base, sharedWith: [] }, alice)).toBe(false);
  });
  it("reaches the granted contact and nobody else", () => {
    const granted = { ...base, sharedWith: [alice] };
    expect(mayReach(granted, alice)).toBe(true);
    expect(mayReach(granted, bob)).toBe(false);
  });
  it("reaches nobody while the service is stopped, however it was granted", () => {
    expect(mayReach({ ...base, enabled: false, sharedWith: [alice, bob] }, alice)).toBe(false);
  });
  it("has no value meaning everyone, and no empty caller that slips through", () => {
    expect(mayReach({ ...base, sharedWith: ["*"] }, alice)).toBe(false);
    expect(mayReach({ ...base, sharedWith: [""] }, "")).toBe(false);
  });
});
