import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";
import * as fakes from "../src/fakes";
import * as testing from "../src/testing";
import * as core from "../src/core";
import * as app from "../src/app";
import { readFileSync } from "node:fs";
// covers: sdk.package

/** The public surface, by name: a name that leaves here is a breaking change (docs/SDK.md, "Versioning"). */
const SURFACE = [
  "PROVIDER_PLATFORMS", "PROVIDER_NETWORKS", "PROVIDER_ID", "networkMode", "offeredIn", "describeProvider", "providerDescriptorProblems",
  "NothingSpentError", "isNothingSpentError", "redact",
  "IDENTITY_PLATFORMS", "verifyIdentity", "identityDescriptorProblems", "availableSigners", "boundedIdentityFetch",
  "identityStatement", "newIdentityBinding", "IDENTITY_MAX_EVIDENCE", "IDENTITY_MAX_VALIDITY",
  "SDK_API", "PLUGIN_ID", "registerAdapters", "pluginProblems", "onAdaptersChanged", "registeredPlugins",
  "registeredLightningProviders", "registeredOnchainProviders", "registeredIdentityProviders", "resetAdapterRegistry",
  "TRANSPORTS", "decodeBolt11", "isBitcoinAddress",
];
const FAKES = [
  "FakeLightningProvider", "FakeOnchainProvider", "fakeInvoice", "fakeAddress", "fakeLightning", "fakeOnchain", "TEST_PROVIDERS_FLAG", "testProvidersEnabled",
  "fakeKey", "fakeAccount", "fakeRecord", "FAKE_IDENTITY_PROVIDERS", "fakeKeyring", "fakeKeySubject", "fakeKeySign", "fakeAccountToken", "fakeRecordText",
  "FAKE_ISSUER", "FAKE_RECORD_HOST", "TEST_IDENTITIES_FLAG", "testIdentitiesEnabled",
];
const TESTING = [...FAKES, "describeLightningProvider", "describeOnchainProvider", "describeIdentityProof"];
/** `@ghostlytools/sdk/app`, what a mini-app bundles: everything else in it is a type. */
const APP = ["MINI_APP_LIMITS", "MINI_APP_ERROR_CODES", "miniAppErrorCode"];

describe("@ghostlytools/sdk", () => {
  it("exports exactly the documented surface", () => {
    expect(Object.keys(sdk).sort()).toEqual([...SURFACE].sort());
    expect(Object.keys(fakes).sort()).toEqual([...FAKES].sort());
    expect(Object.keys(testing).sort()).toEqual([...TESTING].sort());
  });
  it("exports the protocol library under /core", () => {
    for (const name of ["createIdentity", "createLink", "encodeInviteCode", "identityStatement", "RelayTransport", "TRANSPORTS"]) expect(core).toHaveProperty(name);
  });
  it("speaks contract generation 1", () => { expect(sdk.SDK_API).toBe(1); });
  it("exports the mini-app API under /app, from a module that imports nothing", () => {
    expect(Object.keys(app).sort()).toEqual([...APP].sort());
    // An app bundles this module into its one HTML file: an import there would ride along.
    const miniApp = readFileSync(new URL("../../core/src/miniApp.ts", import.meta.url), "utf8");
    expect(miniApp).not.toMatch(/^\s*import\b|\bfrom\s+["']/m);
    // The entry's other imports and exports are types only, which the build erases.
    const entry = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const values = [...entry.matchAll(/^(?:import|export)(\s+type)?\s*\{[^}]*\}\s*from\s*"([^"]+)"/gm)].filter((m) => !m[1]).map((m) => m[2]);
    expect(values).toEqual(["../../core/src/miniApp"]);
  });
  it("keeps the refusal codes sorted, the runners on the same list, and reads a code back from an error", () => {
    expect(app.MINI_APP_ERROR_CODES).toEqual([...app.MINI_APP_ERROR_CODES].sort());
    // Both runners turn anything that is not one of these into "failed" (apps/desktop's Rust tests check its refusals).
    for (const runner of ["../../../apps/web/public/app-frame.html", "../../../apps/desktop/src/app_sandbox.rs"]) {
      const source = readFileSync(new URL(runner, import.meta.url), "utf8");
      const list = /const CODES = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
      expect([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]), runner).toEqual([...app.MINI_APP_ERROR_CODES]);
    }
    expect(app.miniAppErrorCode(new Error("peer-closed"))).toBe("peer-closed");
    expect(app.miniAppErrorCode(new Error("peer closed"))).toBeNull();
    expect(app.miniAppErrorCode("offline")).toBeNull();
    expect(app.MINI_APP_LIMITS.chatDataBytes).toBe(32 * 1024);
  });
});
