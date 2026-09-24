import { execFileSync } from "node:child_process";

/**
 * What a block needs from outside the test process, and how to tell it is
 * there. Everything reads the environment `npm run e2e:matrix` loads from
 * `.env.e2e` (written by the ephemeral environment, e2e/infra) or the gated
 * variables the single-feature specs already use. Unmet, a block is skipped
 * with the reason below, never failed.
 */

const onPath = (tool: string, args: string[] = ["--version"]): boolean => {
  try {
    execFileSync(tool, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const env = (name: string) => process.env[name] ?? "";

export const REQUIREMENTS: Record<string, { met: () => boolean; missing: string }> = {
  mint: {
    met: () => env("E2E_MINT_URL") !== "" || env("MATRIX_NETWORK") === "1",
    missing: "a Cashu test mint: E2E_MINT_URL (npm run e2e:infra:up), or MATRIX_NETWORK=1 for the public testnut",
  },
  s3: {
    met: () => env("GHOSTLY_S3_ENDPOINT").startsWith("http://127.0.0.1:") && env("GHOSTLY_S3_KEY") !== "" && env("GHOSTLY_S3_SECRET") !== "",
    missing: "a local S3 server: GHOSTLY_S3_ENDPOINT/KEY/SECRET (npm run e2e:infra:up)",
  },
  desktop: {
    // support/desktop.ts drives one app through WebDriver, and that app reaches the real Mainline DHT
    // rather than the test relay: a Desktop peer that pairs with a browser one is its own piece of work.
    met: () => false,
    missing: "a Desktop peer: the Linux harness drives one app and has no pairing adapter yet (Linux + tauri-driver only)",
  },
  lnd: { met: () => env("GHOSTLY_LND_REGTEST") === "1", missing: "the LND regtest stack (GHOSTLY_LND_REGTEST=1)" },
  cln: { met: () => env("GHOSTLY_CLN_REGTEST") === "1", missing: "the Core Lightning regtest stack (GHOSTLY_CLN_REGTEST=1)" },
  nwc: { met: () => env("GHOSTLY_NWC_REGTEST") === "1", missing: "the NWC regtest stack (GHOSTLY_NWC_REGTEST=1)" },
  breez: { met: () => env("GHOSTLY_BREEZ_TESTNET") === "1", missing: "Breez's hosted regtest (GHOSTLY_BREEZ_TESTNET=1)" },
  ark: { met: () => env("GHOSTLY_ARK_REGTEST") === "1", missing: "the Arkade regtest stack (GHOSTLY_ARK_REGTEST=1)" },
  bark: { met: () => env("GHOSTLY_BARK_REGTEST") === "1", missing: "the Bark regtest stack (GHOSTLY_BARK_REGTEST=1)" },
  bdk: { met: () => env("GHOSTLY_BDK_REGTEST") === "1", missing: "the BDK regtest stack (GHOSTLY_BDK_REGTEST=1)" },
  bitcoind: { met: () => env("GHOSTLY_BITCOIND_REGTEST") === "1", missing: "a regtest bitcoind (GHOSTLY_BITCOIND_REGTEST=1)" },
  usdt: { met: () => env("GHOSTLY_USDT_LOCAL") === "1", missing: "the local EVM chain with the test token (GHOSTLY_USDT_LOCAL=1)" },
  "ssh-keygen": { met: () => onPath("which", ["ssh-keygen"]), missing: "ssh-keygen on PATH" },
  gpg: { met: () => onPath("gpg") && onPath("gpgconf"), missing: "gpg and gpgconf on PATH" },
};

const cache = new Map<string, boolean>();

/** The reasons these requirements are not met; empty when they all are. */
export function unmet(requirements: readonly string[]): string[] {
  return requirements.flatMap((name) => {
    const requirement = REQUIREMENTS[name];
    if (!requirement) throw new Error(`unknown requirement ${name}`);
    if (!cache.has(name)) cache.set(name, requirement.met());
    return cache.get(name) ? [] : [requirement.missing];
  });
}
