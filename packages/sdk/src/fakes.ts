/**
 * @ghostly/sdk/fakes: the fake adapters the app itself tests with, usable at run time (no vitest):
 * in-memory regtest sats and test identities that hold nothing and reach nothing.
 */
export {
  FakeLightningProvider, FakeOnchainProvider, fakeInvoice, fakeAddress, fakeLightning, fakeOnchain, TEST_PROVIDERS_FLAG, testProvidersEnabled,
  type FakeBehaviour,
} from "../../browser/src/engine/paymentAdapters/providers/testing";
export {
  fakeKey, fakeAccount, fakeRecord, FAKE_IDENTITY_PROVIDERS, fakeKeyring, fakeKeySubject, fakeKeySign, fakeAccountToken, fakeRecordText,
  FAKE_ISSUER, FAKE_RECORD_HOST, TEST_IDENTITIES_FLAG, testIdentitiesEnabled,
  type FakeKeyEvidence, type FakeAccountEvidence,
} from "../../browser/src/proofs/testing";
