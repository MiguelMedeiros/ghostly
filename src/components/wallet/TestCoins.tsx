import { useState } from "react";
import { SEPOLIA_TEST_USDT } from "@ghostly/core";
import type { WalletNetwork, WalletPlatform, WalletState } from "../../lib/platform";
import type { WalletRail } from "../walletCardTypes";
import { CASHU_MINT_SOURCE } from "../walletCardData";
import { NetworkTag } from "../NetworkTag";
import { Block, Button, Notice, Row, Section } from "./ui";

/**
 * Where a Testnet wallet's test coins come from. `ask`: Ghostly asks the faucet itself, on one press. `open`: the
 * faucet wants a login or a CAPTCHA, so the page links to it and the person asks there; Ghostly never solves one.
 */
export type Faucet =
  | { kind: "ask"; amount: string; from: string; needs?: { hint: string; url: string; label: string } }
  | { kind: "open"; url: string; name: string; hint: string };

type OpenFaucet = Extract<Faucet, { kind: "open" }>;
const MUTINYNET: OpenFaucet = { kind: "open", url: "https://faucet.mutinynet.com", name: "Mutinynet faucet", hint: "It asks for a GitHub login, so Ghostly does not ask it for you." };
const LIGHTSPARK: OpenFaucet = { kind: "open", url: "https://app.lightspark.com/regtest-faucet", name: "Lightspark regtest faucet", hint: "It asks for a CAPTCHA, so Ghostly does not ask it for you." };

/**
 * The faucet of one Testnet wallet, from that network's state; null when there is none (Mainnet always, a regtest
 * or local chain, a Fedimint federation, a Lightning source with no public faucet).
 */
export function faucetFor(rail: WalletRail, network: WalletNetwork, state: WalletState): Faucet | null {
  if (network !== "testnet") return null;
  const testMint: Faucet | null = state.mints.length ? { kind: "ask", amount: "10,000 test sats", from: "the test mint" } : null;
  switch (rail) {
    case "cashu": return testMint;
    case "lightning": {
      const source = state.lightning?.providerId ?? CASHU_MINT_SOURCE;
      return source === CASHU_MINT_SOURCE ? testMint : source === "breez" ? LIGHTSPARK : null;
    }
    case "usdt": {
      const usdt = state.usdt;
      if (!usdt?.configured || usdt.chainId !== 11155111 || usdt.token?.toLowerCase() !== SEPOLIA_TEST_USDT.toLowerCase()) return null;
      return {
        kind: "ask", amount: "1,000 TEST-USDT", from: "Aave's Sepolia faucet",
        ...(BigInt(usdt.gasBalance ?? "0") === 0n ? { needs: { hint: "The faucet is paid with a little Sepolia ETH for gas: send some to this wallet's address first.", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia", label: "Open a Sepolia ETH faucet" } } : {}),
      };
    }
    case "arkade": return state.ark?.network === "mutinynet" ? { ...MUTINYNET, hint: `${MUTINYNET.hint} Send to your boarding address: it moves into Ark once confirmed.` } : null;
    case "bark": return state.bark?.network === "signet" ? { kind: "open", url: "https://signet.2nd.dev", name: "Second's signet faucet", hint: "It asks for a GitHub login, so Ghostly does not ask it for you." } : null;
    case "spark": return state.spark?.network === "regtest" ? { ...LIGHTSPARK, hint: `${LIGHTSPARK.hint} Paste your Spark address there.` } : null;
    case "bitcoin": {
      const chain = state.bitcoin?.network;
      if (chain === "mutinynet") return MUTINYNET;
      if (chain === "signet") return { kind: "open", url: "https://signetfaucet.com", name: "Signet faucet", hint: "It asks for a CAPTCHA, so Ghostly does not ask it for you." };
      if (chain === "testnet") return { kind: "open", url: "https://mempool.space/testnet4/faucet", name: "testnet4 faucet", hint: "It asks for a login, so Ghostly does not ask it for you." };
      return null;
    }
    default: return null;
  }
}

/**
 * "Get test coins" on a Testnet wallet's details: one press asks its faucet for a small fixed amount, says it is asking,
 * then what came in or why not (with Retry). Receive never does this by itself. Not on Mainnet: there is no such button.
 */
export function TestCoins({ rail, network, wallet, state }: { rail: WalletRail; network: WalletNetwork; wallet: WalletPlatform; state: WalletState }) {
  const [asking, setAsking] = useState(false);
  const [got, setGot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const faucet = faucetFor(rail, network, state);
  if (!faucet) return null;
  const ask = async () => {
    setAsking(true); setGot(null); setError(null);
    try {
      const result = await wallet.testCoins({ type: rail, network });
      setGot(`+${result.amount.toLocaleString("en-US")} ${result.unit}${result.pending ? " on the way: it shows up here in a few seconds" : ""}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setAsking(false); }
  };
  const label = <span className="inline-flex flex-wrap items-center gap-2">Test coins <NetworkTag network="testnet" testId="test-coins-network" /></span>;
  return (
    <Section title="Test coins" testId="test-coins">
      {faucet.kind === "ask" ? <>
        <Row label={label} hint={`${faucet.amount} from ${faucet.from}, only when you press the button. Worth nothing.`}>
          <Button data-testid="test-coins-get" disabled={asking || !!faucet.needs} aria-busy={asking || undefined} onClick={() => void ask()}>{asking ? "Asking the faucet…" : "Get test coins"}</Button>
        </Row>
        {faucet.needs && <Block><Notice tone="warning" testId="test-coins-needs">{faucet.needs.hint} <a className="underline" href={faucet.needs.url} target="_blank" rel="noopener noreferrer">{faucet.needs.label}</a></Notice></Block>}
        {got && <Block><Notice tone="success" testId="test-coins-result">{got}</Notice></Block>}
        {error && <Block>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Notice tone="error" testId="test-coins-error">{error}</Notice>
            <Button data-testid="test-coins-retry" disabled={asking} onClick={() => void ask()}>Retry</Button>
          </div>
        </Block>}
      </> : (
        <Row label={label} hint={`${faucet.name}. ${faucet.hint}`}>
          <a data-testid="test-coins-open" href={faucet.url} target="_blank" rel="noopener noreferrer"
            className="px-4 py-2 min-h-10 max-md:min-h-11 inline-flex items-center whitespace-nowrap rounded-lg text-sm bg-surface-alt text-text-primary hover:bg-surface-hover border border-border">Open faucet</a>
        </Row>
      )}
    </Section>
  );
}
