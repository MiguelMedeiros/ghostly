import { useState } from "react";
import { SEPOLIA_TEST_USDT } from "@ghostly/core";
import type { WalletNetwork, WalletPlatform, WalletState } from "../../lib/platform";
import type { WalletRail } from "../walletCardTypes";
import { CASHU_MINT_SOURCE } from "../walletCardData";
import { NetworkTag } from "../NetworkTag";
import { Block, Button, Notice, Row, Section } from "./ui";
import { externalLinkProps } from "../../lib/externalLink";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { fillNodes } from "../../lib/fillNodes";
import { formatAmount } from "../../lib/amount";
import { errorText } from "../../lib/errorText";

/**
 * Where a Testnet wallet's test coins come from. `ask`: Ghostly asks the faucet itself, on one press (`coin`: what it
 * gives). `open`: the faucet wants a login or a CAPTCHA (`why`), so the page links to it and the person asks there;
 * Ghostly never solves one. The words are the page's, in the app's language (`faucetWords`).
 */
export type Faucet =
  | { kind: "ask"; coin: "cashu" | "usdt"; needs?: { url: string } }
  | { kind: "open"; url: string; name: FaucetName; why: "github" | "captcha" | "login"; then?: "boarding" | "spark" };
type FaucetName = "mutinynet" | "lightspark" | "second" | "signet" | "testnet4";

type OpenFaucet = Extract<Faucet, { kind: "open" }>;
const MUTINYNET: OpenFaucet = { kind: "open", url: "https://faucet.mutinynet.com", name: "mutinynet", why: "github" };
const LIGHTSPARK: OpenFaucet = { kind: "open", url: "https://app.lightspark.com/regtest-faucet", name: "lightspark", why: "captcha" };

/**
 * The faucet of one Testnet wallet, from that network's state; null when there is none (Mainnet always, a regtest
 * or local chain, a Fedimint federation, a Lightning source with no public faucet).
 */
export function faucetFor(rail: WalletRail, network: WalletNetwork, state: WalletState): Faucet | null {
  if (network !== "testnet") return null;
  const testMint: Faucet | null = state.mints.length ? { kind: "ask", coin: "cashu" } : null;
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
        kind: "ask", coin: "usdt",
        ...(BigInt(usdt.gasBalance ?? "0") === 0n ? { needs: { url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" } } : {}),
      };
    }
    case "arkade": return state.ark?.network === "mutinynet" ? { ...MUTINYNET, then: "boarding" } : null;
    case "bark": return state.bark?.network === "signet" ? { kind: "open", url: "https://signet.2nd.dev", name: "second", why: "github" } : null;
    case "spark": return state.spark?.network === "regtest" ? { ...LIGHTSPARK, then: "spark" } : null;
    case "bitcoin": {
      const chain = state.bitcoin?.network;
      if (chain === "mutinynet") return MUTINYNET;
      if (chain === "signet") return { kind: "open", url: "https://signetfaucet.com", name: "signet", why: "captcha" };
      if (chain === "testnet") return { kind: "open", url: "https://mempool.space/testnet4/faucet", name: "testnet4", why: "login" };
      return null;
    }
    default: return null;
  }
}

/** A faucet's row hint, in the app's language. */
function faucetHint(t: Translate, faucet: Faucet): string {
  if (faucet.kind === "ask") return t(faucet.coin === "usdt" ? "wallet.testCoins.askHint.usdt" : "wallet.testCoins.askHint.cashu");
  const name = t(({
    mutinynet: "wallet.testCoins.faucet.mutinynet",
    lightspark: "wallet.testCoins.faucet.lightspark",
    second: "wallet.testCoins.faucet.second",
    signet: "wallet.testCoins.faucet.signet",
    testnet4: "wallet.testCoins.faucet.testnet4",
  } as const)[faucet.name]);
  const why = t(({
    github: "wallet.testCoins.why.github",
    captcha: "wallet.testCoins.why.captcha",
    login: "wallet.testCoins.why.login",
  } as const)[faucet.why]);
  if (!faucet.then) return t("wallet.testCoins.openHint", { name, why });
  const then = t(faucet.then === "boarding" ? "wallet.testCoins.then.boarding" : "wallet.testCoins.then.spark");
  return t("wallet.testCoins.openHintThen", { name, why, then });
}

/**
 * "Get test coins" on a Testnet wallet's details: one press asks its faucet for a small fixed amount, says it is asking,
 * then what came in or why not (with Retry). Receive never does this by itself. Not on Mainnet: there is no such button.
 */
export function TestCoins({ rail, network, wallet, state }: { rail: WalletRail; network: WalletNetwork; wallet: WalletPlatform; state: WalletState }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const [got, setGot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const faucet = faucetFor(rail, network, state);
  if (!faucet) return null;
  const ask = async () => {
    setAsking(true); setGot(null); setError(null);
    try {
      const result = await wallet.testCoins({ type: rail, network, ...(wallet.lightningCard ? { card: wallet.lightningCard } : {}) });
      // The engine names its unit in English; sats are said in the app's language, a token by its symbol.
      const unit = result.unit === "test sats" ? t("wallet.sats.testnet") : result.unit === "sats" ? t("wallet.sats.mainnet") : result.unit;
      const words = { amount: formatAmount(result.amount, t.language), unit };
      setGot(result.pending ? t("wallet.testCoins.gotPending", words) : t("wallet.testCoins.got", words));
    } catch (e) {
      setError(errorText(e, t));
    } finally { setAsking(false); }
  };
  const label = <span className="inline-flex flex-wrap items-center gap-2">{t("wallet.testCoins.title")} <NetworkTag network="testnet" testId="test-coins-network" /></span>;
  return (
    <Section title={t("wallet.testCoins.title")} testId="test-coins">
      {faucet.kind === "ask" ? <>
        <Row label={label} hint={faucetHint(t, faucet)}>
          <Button data-testid="test-coins-get" disabled={asking || !!faucet.needs} aria-busy={asking || undefined} onClick={() => void ask()}>{asking ? t("wallet.testCoins.asking") : t("wallet.testCoins.get")}</Button>
        </Row>
        {faucet.needs && <Block><Notice tone="warning" testId="test-coins-needs">{fillNodes(t("wallet.testCoins.gas"), { link: <a className="underline" {...externalLinkProps(faucet.needs.url)}>{t("wallet.testCoins.gasLink")}</a> })}</Notice></Block>}
        {got && <Block><Notice tone="success" testId="test-coins-result">{got}</Notice></Block>}
        {error && <Block>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Notice tone="error" testId="test-coins-error">{error}</Notice>
            <Button data-testid="test-coins-retry" disabled={asking} onClick={() => void ask()}>{t("wallet.testCoins.retry")}</Button>
          </div>
        </Block>}
      </> : (
        <Row label={label} hint={faucetHint(t, faucet)}>
          <a data-testid="test-coins-open" {...externalLinkProps(faucet.url)}
            className="px-4 py-2 min-h-10 max-md:min-h-11 inline-flex items-center whitespace-nowrap rounded-lg text-sm bg-surface-alt text-text-primary hover:bg-surface-hover border border-border">{t("wallet.testCoins.open")}</a>
        </Row>
      )}
    </Section>
  );
}
