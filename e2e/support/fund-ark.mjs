// Native ESM avoids Playwright's CJS loader changing the SDK's conditional exports.
import { execFileSync } from "node:child_process";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ArkNote, InMemoryContractRepository, InMemoryWalletRepository, MnemonicIdentity, Wallet } from "@arkade-os/sdk";
if (process.env.GHOSTLY_ARK_REGTEST !== "1") throw new Error("Local regtest opt-in required");
const mnemonic = generateMnemonic(wordlist);
const funder = await Wallet.create({
  identity: MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: false }),
  arkServerUrl: "http://127.0.0.1:43010", esploraUrl: "http://127.0.0.1:43000/api",
  walletMode: "hd", settlementConfig: false,
  storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
});
try {
  const output = execFileSync(process.execPath, [process.env.GHOSTLY_ARK_REGTEST_SCRIPT ?? "/tmp/ghostly-ark-regtest-20260922/regtest.mjs", "arkd", "note", "--amount", "10000"], { encoding: "utf8", stdio: "pipe" });
  const note = output.match(/arknote[a-zA-Z0-9]+/)?.[0];
  if (!note) throw new Error("Regtest faucet returned no note");
  await funder.settle({ inputs: [ArkNote.fromString(note)], outputs: [{ address: await funder.getAddress(), amount: 9900n }] });
} finally { await funder.dispose(); }
// Read through a private child-process pipe by the test, never printed to its report.
process.stdout.write(mnemonic);
