// A disposable Ark wallet funded on e2e/infra's arkd: prints its recovery phrase for the test that spawned it.
// Native ESM avoids Playwright's CJS loader changing the SDK's conditional exports.
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ArkNote, EsploraProvider, InMemoryContractRepository, InMemoryWalletRepository, MnemonicIdentity, RestArkProvider, RestIndexerProvider, Wallet } from "@arkade-os/sdk";
import { ARK_REGTEST, note } from "./ark-regtest/regtest.mjs";
if (process.env.GHOSTLY_ARK_REGTEST !== "1") throw new Error("Local regtest opt-in required");
const mnemonic = generateMnemonic(wordlist);
const funder = await Wallet.create({
  identity: MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: false }),
  // Providers, not URLs: SDK 0.5 ignores `arkServerUrl` and would reach its default (mainnet) server.
  operatorProvider: new RestArkProvider(ARK_REGTEST.server), indexerProvider: new RestIndexerProvider(ARK_REGTEST.server), onchainProvider: new EsploraProvider(ARK_REGTEST.esplora),
  walletMode: "hd", settlementConfig: false,
  storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
});
try {
  await funder.settle({ inputs: [ArkNote.fromString(note(10_000))], outputs: [{ address: await funder.getAddress(), amount: 9900n }] });
} finally { await funder.dispose(); }
// Read through a private child-process pipe by the test, never printed to its report.
process.stdout.write(mnemonic);
