#!/usr/bin/env node
// Drives the USDT part of e2e/infra: Anvil (chain 31337) with the TestUSDT contract, worthless test tokens only.
//   node e2e/support/usdt-local.mjs ready     deploy the contract unless it is already there (idempotent)
// The contract is the first deployment of Anvil's first account, so its address is the same on every fresh chain:
// GHOSTLY_USDT_TOKEN (e2e/infra/env.mjs). Tests read `USDT_LOCAL` for the chain and the token.
import { readFile } from "node:fs/promises";
import { endpoints } from "../infra/env.mjs";

export const USDT_LOCAL = { network: "evm-local", chainId: 31337, provider: endpoints.usdt.rpc, token: endpoints.usdt.token, decimals: 6 };

export async function ready() {
  // Loaded here, not at the top: specs import USDT_LOCAL without paying for the compiler.
  const [{ default: solc }, { ContractFactory, JsonRpcProvider }] = await Promise.all([import("solc"), import("ethers")]);
  const provider = new JsonRpcProvider(USDT_LOCAL.provider);
  try {
    if ((await provider.getNetwork()).chainId !== 31337n) throw new Error("Local chain 31337 required");
    if ((await provider.getCode(USDT_LOCAL.token)) !== "0x") return { ...USDT_LOCAL, deployed: false };
    const input = { language: "Solidity", sources: { "TestUSDT.sol": { content: await readFile(new URL("../contracts/TestUSDT.sol", import.meta.url), "utf8") } }, settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } } };
    const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
    if (compiled.errors?.some((e) => e.severity === "error")) throw new Error("Test contract compilation failed");
    const artifact = compiled.contracts["TestUSDT.sol"].TestUSDT;
    const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, await provider.getSigner(0)).deploy(6);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    if (address.toLowerCase() !== USDT_LOCAL.token.toLowerCase()) throw new Error(`TestUSDT landed at ${address}, not ${USDT_LOCAL.token}: is the chain fresh?`);
    return { ...USDT_LOCAL, deployed: true, label: "TEST-USDT — local fixture, not issued by Tether", compiler: solc.version() };
  } finally { provider.destroy(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "ready") console.log(JSON.stringify(await ready()));
  else { console.error("usage: usdt-local.mjs ready"); process.exit(2); }
}
