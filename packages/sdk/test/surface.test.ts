import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";
import * as fakes from "../src/fakes";
import * as testing from "../src/testing";
import * as core from "../src/core";

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

describe("@ghostly/sdk", () => {
  it("exports exactly the documented surface", () => {
    expect(Object.keys(sdk).sort()).toEqual([...SURFACE].sort());
    expect(Object.keys(fakes).sort()).toEqual([...FAKES].sort());
    expect(Object.keys(testing).sort()).toEqual([...TESTING].sort());
  });
  it("exports the protocol library under /core", () => {
    for (const name of ["createIdentity", "createLink", "encodeInviteCode", "identityStatement", "RelayTransport", "TRANSPORTS"]) expect(core).toHaveProperty(name);
  });
  it("speaks contract generation 1", () => { expect(sdk.SDK_API).toBe(1); });
});
