import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Bolt11Invoice, LightningDestination } from "@ghostly/core";
import { LightningAddressPay } from "./wallet/LightningAddressPay";
import { lightningNetworkFor } from "./walletCardData";
import { MONEY_LABEL, NetworkTag, satsOf } from "./NetworkTag";
import { ConfirmRealMoney } from "./ConfirmRealMoney";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import type { CashuInspection } from "../lib/platform";
import type { MoneyInText } from "../lib/money";
import { MoneyFormatsBubble } from "./MoneyFormatsBubble";
import { moreMoneyMethod } from "../lib/parse/money-more";

const SETTLED_KEY = "ghostly_settled_money";

// Which invoices and tokens this device already dealt with, so the card does not offer them again.
function isSettled(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SETTLED_KEY) ?? "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}
function markSettled(id: string) {
  try {
    const all = JSON.parse(localStorage.getItem(SETTLED_KEY) ?? "[]") as string[];
    localStorage.setItem(SETTLED_KEY, JSON.stringify([...all.filter((entry) => entry !== id), id].slice(-200)));
  } catch {
    // only a convenience
  }
}

const button =
  "px-3 py-1.5 max-md:min-h-11 bg-accent text-on-accent rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const quiet = "px-3 py-1.5 max-md:min-h-11 bg-black/20 hover:bg-black/30 rounded-lg text-xs font-bold transition-colors cursor-pointer inline-flex items-center";

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

function Card({ label, tag, amount, unit, lines, qr, children, testId }: {
  label: string;
  /** Which money: the network's tag beside the label. */
  tag?: React.ReactNode;
  amount: number | null;
  unit: string;
  lines: (string | undefined)[];
  qr: string;
  children: React.ReactNode;
  testId: string;
}) {
  const [showQr, setShowQr] = useState(true);
  return (
    <div className="min-w-[230px] max-md:min-w-[min(230px,68vw)] max-w-[min(300px,72vw)] px-1 py-0.5" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wider text-text-primary/65 m-0 flex items-center gap-2">{label}{tag}</p>
      <p className="m-0 mt-0.5 leading-tight">
        {amount === null ? (
          <span className="text-[15px] font-semibold">Any amount</span>
        ) : (
          <>
            <span className="text-accent mr-1">⚡</span>
            <span className="text-[22px] font-semibold" data-testid="money-amount">{amount.toLocaleString()}</span>
            <span className="text-text-primary/65 text-xs ml-1">{unit === "sat" ? "sats" : unit}</span>
          </>
        )}
      </p>
      {lines.filter(Boolean).map((line) => (
        <p key={line} className="text-[12.5px] leading-snug m-0 mt-1 wrap-break-word text-text-primary/80">{line}</p>
      ))}
      {showQr && (
        <button
          onClick={() => setShowQr(false)}
          className="block mt-2 bg-white p-2.5 rounded-lg cursor-pointer border-none"
          title="Hide the QR code"
        >
          <QRCodeSVG value={qr} size={184} bgColor="#ffffff" fgColor="#0b0f1a" level="L" className="block max-w-full h-auto" />
        </button>
      )}
      <div className="flex flex-wrap gap-1.5 mt-2">
        {children}
        {!showQr && (
          <button className={quiet} onClick={() => setShowQr(true)}>QR</button>
        )}
      </div>
    </div>
  );
}

function relativeExpiry(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "Expired";
  if (left < 90) return `Expires in ${left}s`;
  if (left < 5400) return `Expires in ${Math.round(left / 60)} min`;
  if (left < 172800) return `Expires in ${Math.round(left / 3600)} h`;
  return `Expires in ${Math.round(left / 86400)} days`;
}

function LightningCard({ invoice, mine, off }: { invoice: Bolt11Invoice; mine: boolean; off: boolean }) {
  const all = useServicesPlatform()?.wallet;
  // Paid by the Lightning wallet of the invoice's network: a test invoice never meets real money. An invoice on
  // Bitcoin (a test mint's look the same) goes to the Mainnet wallet when there is one, else the Testnet one; the
  // money named is that wallet's, since that is what leaves.
  const network = lightningNetworkFor(all?.getState(), invoice.network);
  const wallet = all?.forNetwork(network);
  // No Lightning wallet of that network (the profile's wallets are known): said in words, nothing here pays it.
  const known = all?.getState()?.wallets;
  const noWallet = !!known && !known.some((w) => w.type === "lightning" && w.network === network);
  const id = invoice.paymentHash ?? invoice.invoice.slice(-32);
  const [paid, setPaid] = useState(() => isSettled(id));
  // Handed to the mint, which has not settled it yet: paying again could pay twice.
  const [pending, setPending] = useState(false);
  const [quote, setQuote] = useState<{ quote: string; mint: string; amount: number; feeReserve: number } | null>(null);
  /** Real money: Pay opens the second step, and only it pays. */
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const { copied, copy } = useCopy(invoice.invoice);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  const expired = invoice.expiresAt <= now;
  const run = async (task: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pay = (payable: { quote: string; mint: string }, confirmedReal: boolean) =>
    run(async () => {
      try {
        if (!(await wallet!.payQuote(payable.quote, payable.mint, undefined, confirmedReal))) {
          // Pending at the mint: the wallet settles it, or gives the sats back, on its own.
          setQuote(null);
          setConfirming(false);
          setPending(true);
          return;
        }
      } catch (e) {
        // Someone else got there first. The mint refused, so it is not paid twice, and there is nothing left to pay.
        if (!/already paid/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
      markSettled(id);
      setPaid(true);
    });

  return (
    <Card
      testId="invoice-bubble"
      label={invoice.network === "bitcoin" ? "Lightning invoice" : `Lightning invoice · ${invoice.network}`}
      tag={<NetworkTag network={network} testId="invoice-network" />}
      amount={invoice.amountSat}
      unit={satsOf(network)}
      lines={[invoice.description, paid ? undefined : relativeExpiry(invoice.expiresAt, now), !mine && !paid && noWallet ? `${MONEY_LABEL[network]}: you have no ${network === "testnet" ? "Testnet" : "Mainnet"} Lightning wallet to pay it from` : undefined]}
      qr={`lightning:${invoice.invoice}`.toUpperCase()}
    >
      {paid ? (
        <span className="text-accent-hover text-xs font-bold self-center" data-testid="invoice-paid">Paid ✓</span>
      ) : pending ? (
        <span className="text-xs self-center text-text-primary/80" data-testid="invoice-pending">Payment pending at the mint…</span>
      ) : quote && confirming ? (
        <ConfirmRealMoney what={`${quote.amount.toLocaleString()} sats (plus a fee of up to ${quote.feeReserve.toLocaleString()})`} busy={busy} onSend={() => pay(quote, true)} onBack={() => setConfirming(false)} />
      ) : quote ? (
        <>
          <button className={button} disabled={busy} data-testid="invoice-confirm" onClick={() => network === "mainnet" ? setConfirming(true) : pay(quote, false)}>
            {busy ? "Paying…" : `Pay ${quote.amount.toLocaleString()} + up to ${quote.feeReserve.toLocaleString()} fee`}
          </button>
          <button className={quiet} disabled={busy} onClick={() => setQuote(null)}>Cancel</button>
        </>
      ) : (
        <>
          {wallet && !mine && !off && !expired && !noWallet && invoice.amountSat !== null && (
            <button className={button} disabled={busy} data-testid="invoice-pay" onClick={() => run(async () => setQuote(await wallet.quoteInvoice(invoice.invoice)))}>
              {busy ? "Checking…" : "Pay"}
            </button>
          )}
          <button className={quiet} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          {!expired && (
            <a className={`${quiet} no-underline text-inherit`} href={`lightning:${invoice.invoice}`} title="Open in a Lightning wallet on this device">
              Open wallet
            </a>
          )}
        </>
      )}
      {error && <p className="text-danger-ink text-xs m-0 basis-full">{error}</p>}
    </Card>
  );
}

/** A Lightning address or LNURL: resolved and paid through the Lightning source, step by step, when tapped. */
function LightningAddressCard({ destination, mine, off }: { destination: LightningDestination; mine: boolean; off: boolean }) {
  const all = useServicesPlatform()?.wallet;
  const wallet = all?.forNetwork(lightningNetworkFor(all.getState()));
  const [paying, setPaying] = useState(false);
  const { copied, copy } = useCopy(destination.text);
  return (
    <div className="min-w-[230px] max-md:min-w-[min(230px,68vw)] max-w-[min(300px,72vw)] px-1 py-0.5" data-testid="lnurl-bubble">
      <p className="text-[11px] uppercase tracking-wider text-text-primary/65 m-0">{destination.kind === "address" ? "Lightning address" : "LNURL"}</p>
      <p className="m-0 mt-0.5 leading-tight"><span className="text-accent mr-1">⚡</span><span className="text-[15px] font-semibold break-all" data-testid="lnurl-text">{destination.text}</span></p>
      <p className="text-[12.5px] leading-snug m-0 mt-1 text-text-primary/80">Pays through {destination.domain}</p>
      {paying && wallet ? (
        <div className="mt-2"><LightningAddressPay wallet={wallet} text={destination.text} dense onDone={() => setPaying(false)} /></div>
      ) : (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {wallet && !mine && !off && <button className={button} data-testid="lnurl-pay-open" onClick={() => setPaying(true)}>Pay</button>}
          <button className={quiet} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}
    </div>
  );
}

function CashuCard({ value, mine, off }: { value: string; mine: boolean; off: boolean }) {
  const wallet = useServicesPlatform()?.wallet;
  const [inspection, setInspection] = useState<CashuInspection | null | undefined>(undefined);
  const id = value.slice(-40);
  const [redeemed, setRedeemed] = useState(() => isSettled(id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { copied, copy } = useCopy(value);

  useEffect(() => {
    let alive = true;
    (wallet ? wallet.inspectCashu(value) : Promise.resolve(null)).then((result) => alive && setInspection(result), () => alive && setInspection(null));
    return () => {
      alive = false;
    };
  }, [wallet, value]);

  if (!inspection) return <span className="text-[14.2px] leading-[19px] wrap-break-word whitespace-pre-wrap">{value}</span>;

  const host = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  if (inspection.kind === "request") {
    return (
      <Card
        testId="cashu-request-bubble"
        label="Ecash payment request"
        amount={inspection.amount}
        unit={inspection.unit}
        lines={[inspection.description, inspection.mints.length > 0 ? `Mints: ${inspection.mints.map(host).join(", ")}` : undefined]}
        qr={value}
      >
        <button className={quiet} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </Card>
    );
  }

  return (
    <Card
      testId="cashu-token-bubble"
      label="Ecash token"
      amount={inspection.amount}
      unit={inspection.unit}
      lines={[inspection.memo, `Mint: ${host(inspection.mint)}`, !inspection.accepted && !mine ? "You have not added this mint, so it cannot be redeemed here." : undefined]}
      qr={value}
    >
      {redeemed ? (
        <span className="text-accent-hover text-xs font-bold self-center" data-testid="token-redeemed">Redeemed ✓</span>
      ) : (
        wallet && !mine && !off && inspection.accepted && (
          <button
            className={button}
            disabled={busy}
            data-testid="token-redeem"
            onClick={async () => {
              setError("");
              setBusy(true);
              try {
                await wallet.receiveToken(value);
                markSettled(id);
                setRedeemed(true);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Redeeming…" : "Redeem"}
          </button>
        )
      )}
      <button className={quiet} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      {error && <p className="text-danger-ink text-xs m-0 basis-full">{error}</p>}
    </Card>
  );
}

const METHOD_NAME = { cashu: "Cashu", lightning: "Lightning", bitcoin: "On-chain Bitcoin", arkade: "Ark", bark: "Bark", usdt: "USDT" } as const;

/** Money pasted into the chat, shown as something a person can read and act on. */
/** `peerPubKey`: the chat it is in, whose choice of ways of paying decides whether it can be paid or redeemed here. */
export function InvoiceBubble({ money, mine, peerPubKey }: { money: MoneyInText; mine: boolean; peerPubKey?: string }) {
  const allowed = useServicesPlatform()?.getPeer(peerPubKey ?? "")?.paymentMethods;
  const method = money.type === "cashu" ? "cashu" : money.type === "lightning" || money.type === "lnurl" ? "lightning" : moreMoneyMethod(money);
  const off = !!allowed && !allowed[method];
  return (
    <>
      {money.rest && <p className="text-[14.2px] leading-[19px] wrap-break-word whitespace-pre-wrap m-0 mb-1.5">{money.rest}</p>}
      {money.type === "lightning" ? <LightningCard invoice={money.invoice} mine={mine} off={off} /> : money.type === "lnurl" ? <LightningAddressCard destination={money.destination} mine={mine} off={off} /> : money.type === "cashu" ? <CashuCard value={money.value} mine={mine} off={off} />
        : <MoneyFormatsBubble money={money} mine={mine} off={off} renderLightning={(invoice) => <LightningCard invoice={invoice} mine={mine} off={!!allowed && !allowed.lightning} />} />}
      {off && !mine && <p className="text-[11px] text-text-primary/65 mt-1" data-testid="money-off">{METHOD_NAME[method]} is off in this chat.</p>}
    </>
  );
}
