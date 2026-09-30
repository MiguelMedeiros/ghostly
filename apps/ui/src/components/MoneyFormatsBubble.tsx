import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { formatPaymentAmount, parsePaymentAmount, type Bolt11Invoice, type PaymentReview as Review, type PaymentTarget, type WalletNetwork } from "@ghostly/core";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useAppNavigation } from "../hooks/useAppNavigation";
import type { WalletPlatform, WalletState } from "../lib/platform";
import type { MoreMoney } from "../lib/parse/money-more";
import type { OnchainRequest } from "../lib/parse/money-bitcoin";
import { chainAccepts } from "../lib/parse/money-bitcoin";
import type { Bolt12Offer } from "../lib/parse/money-bolt12";
import type { ArkRequest } from "../lib/parse/money-ark";
import { USDT_CHAINS, type UsdtRequest } from "../lib/parse/money-usdt";
import { useI18n } from "../contexts/I18nContext";
import { moneyLabel, satsIn } from "./NetworkTag";
import { PaymentReview } from "./PaymentReview";
import { OpenInWallet } from "./OpenInWallet";
import { ONCHAIN_FEE_CAP } from "./walletCardData";
import { decimalInput, formatAmount, formatTokenAmount } from "../lib/amount";
import { errorText } from "../lib/errorText";

const button =
  "px-3 py-1.5 max-md:min-h-11 bg-accent text-on-accent rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const quiet = "px-3 py-1.5 max-md:min-h-11 bg-black/20 hover:bg-black/30 rounded-lg text-xs font-bold transition-colors cursor-pointer inline-flex items-center";
const field = "w-full rounded-lg bg-black/20 px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-primary/50 outline-none focus-visible:outline-2 focus-visible:outline-accent";

const NETWORK_NAME: Record<WalletNetwork, string> = { mainnet: "Mainnet", testnet: "Testnet" };
const WALLET_NAME = { bitcoin: "Bitcoin", arkade: "Ark", bark: "Bark", usdt: "USDT" } as const;
type Rail = keyof typeof WALLET_NAME;

/**
 * The network of pasted money, in words as well as colour: "Test money" (worthless coins) or "Real money".
 * `chain` names the test chain when the prefix says it. Absent network: the text does not say which chain.
 */
export function MoneyNetworkTag({ network, chain }: { network?: WalletNetwork; chain?: string }) {
  const { t } = useI18n();
  if (!network) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-text-primary/35 px-2 py-0.5 text-[11px] font-semibold" data-testid="money-network" data-network="unknown">
        {t("payments.formats.networkNotStated")}
      </span>
    );
  }
  const test = network === "testnet";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${test ? "border-dashed border-text-primary/45 bg-black/15" : "border-accent/70 money-ink-mainnet"}`}
      data-testid="money-network"
      data-network={network}
    >
      <span aria-hidden="true">{test ? "◇" : "◆"}</span>
      {moneyLabel(t, network)}
      {test && chain && <span className="font-normal opacity-80">· {chain}</span>}
    </span>
  );
}

function useCopy(value: string) {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: async () => {
      await navigator.clipboard.writeText(value).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
  };
}

function Shell({ label, network, chain, amount, testId, lines, detail, qr, children }: {
  label: string;
  network?: WalletNetwork;
  chain?: string;
  amount: React.ReactNode;
  testId: string;
  lines: (string | undefined)[];
  /** The address or code itself, in full: what is paid is never hidden. */
  detail: string;
  qr: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [showQr, setShowQr] = useState(false);
  return (
    <div className="min-w-[230px] max-md:min-w-[min(230px,68vw)] max-w-[min(300px,72vw)] px-1 py-0.5" data-testid={testId} data-network={network ?? "unknown"}>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="text-[11px] uppercase tracking-wider text-text-primary/65 m-0">{label}</p>
        <MoneyNetworkTag network={network} chain={chain} />
      </div>
      <p className="m-0 mt-1 leading-tight">{amount}</p>
      {lines.filter(Boolean).map((line) => (
        <p key={line} className="text-[12.5px] leading-snug m-0 mt-1 wrap-break-word text-text-primary/80">{line}</p>
      ))}
      <p className="font-mono text-[11.5px] leading-snug m-0 mt-1.5 break-all text-text-primary/80" data-testid="money-detail">{detail}</p>
      {showQr && (
        <button onClick={() => setShowQr(false)} className="block mt-2 bg-white p-2.5 rounded-lg cursor-pointer border-none" title={t("payments.invoice.hideQr")}>
          <QRCodeSVG value={qr} size={184} bgColor="#ffffff" fgColor="#0b0f1a" level="L" className="block max-w-full h-auto" />
        </button>
      )}
      <div className="flex flex-wrap gap-1.5 mt-2">
        {children}
        <button className={quiet} onClick={() => setShowQr(!showQr)}>{showQr ? t("payments.formats.hideQr") : "QR"}</button>
      </div>
    </div>
  );
}

function Amount({ sats, network }: { sats?: number; network: WalletNetwork }) {
  const { t } = useI18n();
  if (sats === undefined) return <span className="text-[15px] font-semibold">{t("payments.invoice.anyAmount")}</span>;
  return (
    <>
      <span className="text-[22px] font-semibold" data-testid="money-amount">{formatAmount(sats, t.language)}</span>
      <span className="text-text-primary/65 text-xs ms-1">{satsIn(t, network)}</span>
    </>
  );
}

/** Which of the profile's wallets pays on a network: that network's view, whatever page the profile shows. */
function networkView(state: WalletState | null, network: WalletNetwork): Partial<WalletState> | undefined {
  const all = state as (WalletState & { networks?: Record<WalletNetwork, Partial<WalletState>> }) | null;
  if (all?.networks) return all.networks[network];
  // An engine from before per-network wallets: only the network it shows.
  return (all?.mode ?? "mainnet") === network ? all ?? undefined : undefined;
}

function hasWallet(view: Partial<WalletState> | undefined, rail: Rail): boolean {
  if (!view) return false;
  if (rail === "bitcoin") return !!view.bitcoin && view.bitcoin.status !== "none";
  if (rail === "arkade") return !!view.ark?.configured;
  if (rail === "bark") return !!view.bark?.configured;
  return !!view.usdt?.configured;
}

/**
 * No wallet of this kind on the money's network: it says so, never offers the other network's wallet (test coins
 * and real money never meet), and offers to make one (Wallets → New, on that network).
 */
function NoWallet({ rail, network, other }: { rail: Rail; network: WalletNetwork; other: boolean }) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  return (
    <div className="basis-full text-[12px] leading-snug mt-0.5" data-testid="money-no-wallet">
      <p className="m-0">{t(`payments.formats.noWallet.${network}`, { wallet: WALLET_NAME[rail] })}</p>
      {other && <p className="m-0 mt-0.5 text-text-primary/70">{t("payments.formats.otherNeverPays", { network: NETWORK_NAME[network === "mainnet" ? "testnet" : "mainnet"], wallet: WALLET_NAME[rail] })}</p>}
      <button className={`${quiet} mt-1.5`} data-testid="money-create-wallet" onClick={() => nav.place("/wallet", { newWallet: { type: rail, network } })}>
        {t("payments.formats.createWallet", { network: NETWORK_NAME[network], wallet: WALLET_NAME[rail] })}
      </button>
    </div>
  );
}

/**
 * Tap Pay, check the amount and the fee limit, then the usual review (Approve or Cancel): nothing is sent from
 * the card itself. `prepare` builds the target for the wallet of the money's own network.
 */
function PayStep({ wallet, fixedAmount, unit, defaultFee, feeUnit, parse, prepare, testId }: {
  wallet: WalletPlatform;
  fixedAmount?: string;
  unit: string;
  defaultFee: string;
  feeUnit: string;
  parse: (amount: string) => number;
  prepare: (amount: number, feeCap: number) => Promise<Review>;
  testId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(fixedAmount ?? "");
  const [fee, setFee] = useState(defaultFee);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (review) return <div className="basis-full mt-1"><PaymentReview review={review} wallet={wallet} onClose={() => { setReview(null); setOpen(false); }} /></div>;
  if (!open) return <button className={button} data-testid={`${testId}-pay`} onClick={() => setOpen(true)}>{t("payments.invoice.pay")}</button>;
  let value = NaN;
  try { value = parse(amount); } catch { /* not a number yet */ }
  return (
    <div className="basis-full space-y-1.5" data-testid={`${testId}-pay-form`}>
      {fixedAmount === undefined && (
        <label className="block text-[12px]">{t("payments.formats.amount", { unit })}
          <input aria-label={t("payments.formats.amountAria", { unit })} inputMode="decimal" className={field} value={amount} onChange={(e) => setAmount(decimalInput(e.target.value, t.language))} data-testid="money-pay-amount" />
        </label>
      )}
      <label className="block text-[12px]">{t("payments.formats.maxFee", { unit: feeUnit })}
        <input aria-label={t("payments.formats.maxFeeAria", { unit: feeUnit })} inputMode="decimal" className={field} value={fee} onChange={(e) => setFee(decimalInput(e.target.value, t.language))} />
      </label>
      <div className="flex flex-wrap gap-1.5">
        <button
          className={button}
          disabled={busy || !(value > 0)}
          data-testid="money-review"
          onClick={async () => {
            setBusy(true); setError("");
            try { setReview(await prepare(value, Number(fee))); }
            catch (e) { setError(errorText(e, t)); }
            finally { setBusy(false); }
          }}
        >
          {busy ? t("payments.bubble.preparing") : t("payments.bubble.review")}
        </button>
        <button className={quiet} disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</button>
      </div>
      {error && <p className="text-danger-ink text-xs m-0" role="alert" data-testid="money-pay-error">{error}</p>}
    </div>
  );
}

const inFive = () => Date.now() + 5 * 60 * 1000;
const wholeSats = (text: string) => { if (!/^\d+$/.test(text)) throw new Error("whole sats"); return Number(text); };

function OnchainCard({ request, mine, off, lightning }: { request: OnchainRequest; mine: boolean; off: boolean; lightning?: React.ReactNode }) {
  const { t } = useI18n();
  const wallet = useServicesPlatform()?.wallet;
  const state = wallet?.getState() ?? null;
  const view = networkView(state, request.network), other = networkView(state, request.network === "mainnet" ? "testnet" : "mainnet");
  const bitcoin = view?.bitcoin;
  const { copied, copy } = useCopy(request.address);
  const chainName = request.chain === "regtest" ? "regtest" : request.chain === "testnet" ? "testnet / signet" : undefined;
  const payable = !!wallet && !mine && !off && !request.unsupported;
  let status: React.ReactNode = null;
  if (payable && !hasWallet(view, "bitcoin")) status = <NoWallet rail="bitcoin" network={request.network} other={hasWallet(other, "bitcoin")} />;
  else if (payable && bitcoin?.network && !chainAccepts(bitcoin.network, request.address)) {
    status = <p className="basis-full text-[12px] m-0" data-testid="money-wrong-chain">{t("payments.formats.wrongChain", { network: NETWORK_NAME[request.network], chain: bitcoin.network, target: chainName ?? request.chain })}</p>;
  } else if (payable && bitcoin?.status !== "ready") {
    status = <p className="basis-full text-[12px] m-0" data-testid="money-wallet-offline">{t("payments.formats.offline", { network: NETWORK_NAME[request.network] })}</p>;
  } else if (payable && bitcoin?.network) {
    const chain = bitcoin.network;
    status = (
      <PayStep
        wallet={wallet!} testId="onchain" unit={satsIn(t, request.network)} feeUnit={satsIn(t, request.network)} defaultFee={String(ONCHAIN_FEE_CAP)}
        fixedAmount={request.amountSat === undefined ? undefined : String(request.amountSat)} parse={wholeSats}
        prepare={(amount, feeCap) => wallet!.preparePayment({
          target: { method: "bitcoin", network: chain as PaymentTarget["network"], provider: "onchain", asset: "BTC", unit: "sat", address: request.address, expiresAt: Date.now() + 15 * 60 * 1000 },
          amount, feeCap, payee: request.address, ...(request.message || request.label ? { memo: request.message ?? request.label } : {}),
        })}
      />
    );
  }
  return (
    <>
      <Shell
        testId="onchain-bubble" label={request.uri ? t("payments.formats.paymentLink") : t("payments.formats.address")} network={request.network} chain={chainName}
        amount={<Amount sats={request.amountSat} network={request.network} />}
        lines={[request.label, request.message, request.unsupported ? t("payments.formats.unsupported") : undefined]}
        detail={request.address} qr={request.uri ?? `bitcoin:${request.address}`}
      >
        {status}
        <button className={quiet} onClick={copy}>{copied ? t("payments.invoice.copied") : t("payments.formats.copyAddress")}</button>
        <OpenInWallet className={`${quiet} no-underline text-inherit`} uri={request.uri ?? `bitcoin:${request.address}`} title={t("payments.formats.openBitcoinTitle")} testId="onchain-open-wallet">{t("payments.invoice.openWallet")}</OpenInWallet>
      </Shell>
      {lightning && (
        <div className="mt-2" data-testid="onchain-lightning">
          <p className="text-[11px] text-text-primary/65 m-0 mb-1">{t("payments.formats.orLightning")}</p>
          {lightning}
        </div>
      )}
    </>
  );
}

function Bolt12Card({ offer }: { offer: Bolt12Offer }) {
  const { t } = useI18n();
  const { copied, copy } = useCopy(offer.offer);
  const chain = offer.network === "testnet" && offer.chain !== "other" ? offer.chain : undefined;
  const amount = offer.amountSat !== undefined
    ? <Amount sats={offer.amountSat} network={offer.network} />
    : offer.currency && offer.currencyAmount !== undefined
      ? <span className="text-[15px] font-semibold">{offer.currency} {offer.currencyAmount.toString()} <span className="text-xs font-normal">{t("payments.formats.smallestUnit")}</span></span>
      : offer.amountMsat !== undefined ? <span className="text-[15px] font-semibold">{t("payments.formats.millisats", { amount: offer.amountMsat.toString() })}</span>
      : <span className="text-[15px] font-semibold">{t("payments.invoice.anyAmount")}</span>;
  return (
    <Shell
      testId="bolt12-bubble" label={t("payments.formats.bolt12")} network={offer.network} chain={chain} amount={amount}
      lines={[offer.description, offer.issuer ? t("payments.formats.from", { issuer: offer.issuer }) : undefined, t("payments.formats.bolt12Hint")]}
      detail={offer.offer} qr={offer.offer.toUpperCase()}
    >
      <button className={quiet} onClick={copy}>{copied ? t("payments.invoice.copied") : t("payments.formats.copyOffer")}</button>
      <OpenInWallet className={`${quiet} no-underline text-inherit`} uri={`lightning:${offer.offer}`} title={t("payments.invoice.openTitle")} testId="bolt12-open-wallet">{t("payments.invoice.openWallet")}</OpenInWallet>
    </Shell>
  );
}

function ArkCard({ request, mine, off }: { request: ArkRequest; mine: boolean; off: boolean }) {
  const { t } = useI18n();
  const wallet = useServicesPlatform()?.wallet;
  const state = wallet?.getState() ?? null;
  const rail = request.kind;
  const view = networkView(state, request.network), other = networkView(state, request.network === "mainnet" ? "testnet" : "mainnet");
  const ark = rail === "arkade" ? view?.ark : view?.bark;
  const { copied, copy } = useCopy(request.address);
  const uri = request.uri ?? `bitcoin:?ark=${request.address}`;
  let status: React.ReactNode = null;
  if (wallet && !mine && !off) {
    if (!hasWallet(view, rail)) status = <NoWallet rail={rail} network={request.network} other={hasWallet(other, rail)} />;
    else if (ark?.locked) status = <p className="basis-full text-[12px] m-0" data-testid="money-wallet-locked">{t("payments.formats.unlock", { network: NETWORK_NAME[request.network], wallet: WALLET_NAME[rail] })}</p>;
    else if (ark?.network && ark.provider) {
      const { network, provider } = ark;
      status = (
        <PayStep
          wallet={wallet} testId="ark" unit={satsIn(t, request.network)} feeUnit={satsIn(t, request.network)} defaultFee="100"
          fixedAmount={request.amountSat === undefined ? undefined : String(request.amountSat)} parse={wholeSats}
          prepare={(amount, feeCap) => wallet.preparePayment({
            target: { method: rail, network: network as PaymentTarget["network"], provider, asset: "BTC", unit: "sat", address: request.address, expiresAt: inFive() },
            amount, feeCap: Math.max(feeCap, 0), payee: request.address,
          })}
        />
      );
    }
  }
  return (
    <Shell
      testId="ark-bubble" label={rail === "arkade" ? t("payments.formats.arkadeLabel") : t("payments.formats.barkLabel")} network={request.network}
      amount={<Amount sats={request.amountSat} network={request.network} />}
      lines={[rail === "arkade" ? t("payments.formats.arkadeHint") : t("payments.formats.barkHint")]}
      detail={request.address} qr={uri}
    >
      {status}
      <button className={quiet} onClick={copy}>{copied ? t("payments.invoice.copied") : t("payments.formats.copyAddress")}</button>
    </Shell>
  );
}

function UsdtCard({ request, mine, off }: { request: UsdtRequest; mine: boolean; off: boolean }) {
  const { t } = useI18n();
  const wallet = useServicesPlatform()?.wallet;
  const state = wallet?.getState() ?? null;
  const chain = request.chainId !== undefined ? USDT_CHAINS[request.chainId]?.name ?? t("payments.formats.chainId", { id: request.chainId }) : undefined;
  const { copied, copy } = useCopy(request.recipient);
  const network = request.network;
  const view = network ? networkView(state, network) : undefined, other = network ? networkView(state, network === "mainnet" ? "testnet" : "mainnet") : undefined;
  const usdt = view?.usdt;
  const decimals = usdt?.decimals ?? 6;
  const amount = request.amount !== undefined
    ? <><span className="text-[22px] font-semibold" data-testid="money-amount">{formatTokenAmount(request.amount.toString(), decimals, t.language)}</span><span className="text-text-primary/65 text-xs ms-1">{network === "mainnet" ? "USDT" : t("payments.formats.testUsdt")}</span></>
    : <span className="text-[15px] font-semibold">{t("payments.invoice.anyAmount")}</span>;
  let status: React.ReactNode = null;
  if (!network) {
    status = <p className="basis-full text-[12px] m-0" data-testid="money-network-unknown">{request.chainId !== undefined ? t("payments.formats.usdtOtherChain", { chain: chain ?? "" }) : t("payments.formats.usdtNoChain")}</p>;
  } else if (wallet && !mine && !off) {
    if (!hasWallet(view, "usdt")) status = <NoWallet rail="usdt" network={network} other={hasWallet(other, "usdt")} />;
    else if (usdt?.locked) status = <p className="basis-full text-[12px] m-0" data-testid="money-wallet-locked">{t("payments.formats.unlock", { network: NETWORK_NAME[network], wallet: "USDT" })}</p>;
    else if (usdt?.chainId !== request.chainId) status = <p className="basis-full text-[12px] m-0" data-testid="money-wrong-chain">{t("payments.formats.usdtWrongChain", { network: NETWORK_NAME[network], chain: USDT_CHAINS[usdt?.chainId ?? 0]?.name ?? t("payments.formats.anotherChain"), target: chain ?? "" })}</p>;
    else if (request.token && usdt?.token && request.token !== usdt.token.toLowerCase()) status = <p className="basis-full text-[12px] m-0" data-testid="money-wrong-token">{t("payments.formats.wrongToken")}</p>;
    else if (usdt?.network && usdt.provider && usdt.token) {
      const { network: evm, provider, token } = usdt;
      status = (
        <PayStep
          wallet={wallet} testId="usdt" unit={network === "mainnet" ? "USDT" : t("payments.formats.testUsdt")} feeUnit="ETH" defaultFee="0.001"
          fixedAmount={request.amount === undefined ? undefined : formatPaymentAmount(request.amount.toString(), decimals).replace(/,/g, "")}
          parse={(text) => parsePaymentAmount(text, decimals)}
          prepare={(value, gas) => {
            const now = Date.now();
            return wallet.preparePayment({
              target: { method: "usdt", network: evm, provider, asset: request.chainId === 1 ? "USDT" : "TEST-USDT", unit: "token-base", address: request.recipient, token, decimals, chainId: request.chainId, issuedAt: now, expiresAt: now + 15 * 60 * 1000 },
              amount: value, feeCap: parsePaymentAmount(String(gas), 18), payee: request.recipient,
            });
          }}
        />
      );
    }
  }
  return (
    <Shell
      testId="usdt-bubble" label={chain ? t("payments.formats.usdtLabelChain", { chain }) : t("payments.formats.usdtLabel")} network={network} amount={amount}
      lines={[]} detail={request.recipient} qr={request.uri ?? request.recipient}
    >
      {status}
      <button className={quiet} onClick={copy}>{copied ? t("payments.invoice.copied") : t("payments.formats.copyAddress")}</button>
    </Shell>
  );
}

/**
 * Money beyond invoices and ecash: a Bitcoin address or `bitcoin:` link, a BOLT 12 offer, an Ark address, a USDT
 * address. Each card says its network in words, pays only from a wallet of that network, and through the review.
 * `renderLightning`: the Lightning card of a `bitcoin:` link's `lightning=` fallback.
 */
export function MoneyFormatsBubble({ money, mine, off, renderLightning }: { money: MoreMoney; mine: boolean; off: boolean; renderLightning: (invoice: Bolt11Invoice) => React.ReactNode }) {
  switch (money.type) {
    case "onchain": return <OnchainCard request={money.request} mine={mine} off={off} lightning={money.request.lightning ? renderLightning(money.request.lightning) : undefined} />;
    case "bolt12": return <Bolt12Card offer={money.offer} />;
    case "ark": return <ArkCard request={money.request} mine={mine} off={off} />;
    case "usdt": return <UsdtCard request={money.request} mine={mine} off={off} />;
  }
}
