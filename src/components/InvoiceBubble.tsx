import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Bolt11Invoice } from "@ghostly/core";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { playSound } from "../lib/sounds";
import type { CashuInspection } from "../lib/platform";
import type { MoneyInText } from "../lib/money";

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
  "px-3 py-1.5 max-md:min-h-11 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
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

function Card({ label, amount, unit, lines, qr, children, testId }: {
  label: string;
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
      <p className="text-[11px] uppercase tracking-wider text-[hsla(0,0%,100%,0.6)] m-0">{label}</p>
      <p className="m-0 mt-0.5 leading-tight">
        {amount === null ? (
          <span className="text-[15px] font-semibold">Any amount</span>
        ) : (
          <>
            <span className="text-accent mr-1">⚡</span>
            <span className="text-[22px] font-semibold" data-testid="money-amount">{amount.toLocaleString()}</span>
            <span className="text-[hsla(0,0%,100%,0.6)] text-xs ml-1">{unit === "sat" ? "sats" : unit}</span>
          </>
        )}
      </p>
      {lines.filter(Boolean).map((line) => (
        <p key={line} className="text-[12.5px] leading-snug m-0 mt-1 wrap-break-word text-[hsla(0,0%,100%,0.75)]">{line}</p>
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

function LightningCard({ invoice, mine }: { invoice: Bolt11Invoice; mine: boolean }) {
  const wallet = useServicesPlatform()?.wallet;
  const id = invoice.paymentHash ?? invoice.invoice.slice(-32);
  const [paid, setPaid] = useState(() => isSettled(id));
  const [quote, setQuote] = useState<{ quote: string; mint: string; amount: number; feeReserve: number } | null>(null);
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

  return (
    <Card
      testId="invoice-bubble"
      label={invoice.network === "bitcoin" ? "Lightning invoice" : `Lightning invoice · ${invoice.network}`}
      amount={invoice.amountSat}
      unit="sat"
      lines={[invoice.description, paid ? undefined : relativeExpiry(invoice.expiresAt, now)]}
      qr={`lightning:${invoice.invoice}`.toUpperCase()}
    >
      {paid ? (
        <span className="text-accent text-xs font-bold self-center" data-testid="invoice-paid">Paid ✓</span>
      ) : quote ? (
        <>
          <button
            className={button}
            disabled={busy}
            data-testid="invoice-confirm"
            onClick={() =>
              run(async () => {
                try {
                  if (!(await wallet!.payQuote(quote.quote, quote.mint))) throw new Error("The mint could not pay this invoice");
                  playSound("confirmed");
                } catch (e) {
                  // Someone else got there first. The mint refused, so it is not paid twice, and there is nothing left to pay.
                  if (!/already paid/i.test(e instanceof Error ? e.message : String(e))) throw e;
                }
                markSettled(id);
                setPaid(true);
              })
            }
          >
            {busy ? "Paying…" : `Pay ${quote.amount.toLocaleString()} + up to ${quote.feeReserve.toLocaleString()} fee`}
          </button>
          <button className={quiet} disabled={busy} onClick={() => setQuote(null)}>Cancel</button>
        </>
      ) : (
        <>
          {wallet && !mine && !expired && invoice.amountSat !== null && (
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
      {error && <p className="text-danger text-xs m-0 basis-full">{error}</p>}
    </Card>
  );
}

function CashuCard({ value, mine }: { value: string; mine: boolean }) {
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
        <span className="text-accent text-xs font-bold self-center" data-testid="token-redeemed">Redeemed ✓</span>
      ) : (
        wallet && !mine && inspection.accepted && (
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
                playSound("coin");
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
      {error && <p className="text-danger text-xs m-0 basis-full">{error}</p>}
    </Card>
  );
}

/** Money pasted into the chat, shown as something a person can read and act on. */
export function InvoiceBubble({ money, mine }: { money: MoneyInText; mine: boolean }) {
  return (
    <>
      {money.rest && <p className="text-[14.2px] leading-[19px] wrap-break-word whitespace-pre-wrap m-0 mb-1.5">{money.rest}</p>}
      {money.type === "lightning" ? <LightningCard invoice={money.invoice} mine={mine} /> : <CashuCard value={money.value} mine={mine} />}
    </>
  );
}
