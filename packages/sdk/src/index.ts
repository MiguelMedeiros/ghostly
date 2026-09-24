/**
 * @ghostly/sdk: what someone building for Ghostly needs, and nothing of the app's internals.
 *
 *  - Wallet sources: the `LightningProvider` and `OnchainProvider` contracts, their descriptors, the
 *    money-safety error (`NothingSpentError`) and the descriptor checks.
 *  - Identity proofs: the `IdentityProofProvider` contract, its signers, and the shared verification.
 *  - Plugins: `registerAdapters`, the one way an adapter written outside the app gets into it.
 *  - Transports and records: the contracts a transport or a minimal client implements (from the core).
 *
 * Fakes and contract test suites: `@ghostly/sdk/testing`. The whole protocol library: `@ghostly/sdk/core`.
 * Read docs/SDK.md first: the rules about money and secrets are not optional.
 */

// Wallet sources
export type {
  ProviderPlatform, ProviderKind, ProviderNetwork, ProviderField, ProviderSettings, ProviderHost, ProviderDescriptor, ProviderDescriptorView,
} from "../../browser/src/engine/paymentAdapters/providers/types";
export {
  PROVIDER_PLATFORMS, PROVIDER_NETWORKS, PROVIDER_ID, networkMode, offeredIn, describeProvider, providerDescriptorProblems,
  NothingSpentError, isNothingSpentError, redact,
} from "../../browser/src/engine/paymentAdapters/providers/types";
export type { WalletMode } from "../../browser/src/shared/mints";
export type {
  LightningInfo, LightningInvoice, InvoiceStatus, LightningPaymentRef, LightningPayResult, LightningPaymentStatus, LightningCapabilities,
  LightningProvider, LightningProviderDescriptor,
} from "../../browser/src/engine/paymentAdapters/providers/lightning";
export type {
  OnchainInfo, OnchainBalance, OnchainSendRequest, OnchainPrepared, OnchainTxStatus, OnchainTx, OnchainProvider, OnchainProviderDescriptor,
} from "../../browser/src/engine/paymentAdapters/providers/onchain";

// Identity proofs
export type {
  IdentityCategory, IdentityPlatform, IdentityFetchOptions, IdentityFetchResponse, IdentityFetch, VerifyContext, SubjectSpec, SignerField,
  SignerContext, SignerSession, InstructionStep, SignerInstructions, InAppSigner, ExternalToolSigner, RedirectSigner, PublishSigner,
  IdentitySigner, IdentityProofProvider,
} from "../../browser/src/proofs/contract";
export { IDENTITY_PLATFORMS } from "../../browser/src/proofs/contract";
export { verifyIdentity, descriptorProblems as identityDescriptorProblems, availableSigners, boundedIdentityFetch } from "../../browser/src/proofs/verify";
export type {
  IdentityStatement, IdentityBinding, VerifiedIdentity, IdentityDisplay, LocalIdentityProof,
} from "@ghostly/core";
export { identityStatement, newIdentityBinding, IDENTITY_MAX_EVIDENCE, IDENTITY_MAX_VALIDITY } from "@ghostly/core";

// Plugins: registration without touching a registry
export type { GhostlyAdapterPlugin, AdapterKind } from "../../browser/src/plugins/registry";
export {
  SDK_API, PLUGIN_ID, registerAdapters, pluginProblems, onAdaptersChanged, registeredPlugins,
  registeredLightningProviders, registeredOnchainProviders, registeredIdentityProviders, resetAdapterRegistry,
} from "../../browser/src/plugins/registry";

// Transports and the records a minimal client handles
export type {
  BitcoinNetwork, PkarrTransport, GhostRecord, SignedPacket, Identity,
  NativeEndpoint, NativeTransport, NativeBinding, BoundChannel, TransportDescriptors, PairedTransport, FrameChannel,
} from "@ghostly/core";
export { TRANSPORTS, decodeBolt11, isBitcoinAddress } from "@ghostly/core";
