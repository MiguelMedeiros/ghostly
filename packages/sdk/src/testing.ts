/**
 * @ghostly/sdk/testing: the contract suites every adapter runs against itself, plus the fakes of
 * `@ghostly/sdk/fakes`. Needs vitest (a peer dependency): import it from test files only.
 */
export * from "./fakes";
export { describeLightningProvider, describeOnchainProvider, type LightningHarness, type OnchainHarness } from "../../browser/src/engine/paymentAdapters/providers/contractSuite";
export { describeIdentityProof, type IdentityProofHarness } from "../../browser/src/proofs/contractSuite";
