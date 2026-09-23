import { useState } from "react";
import type { PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { BackupRows } from "./wallet/BackupRows";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, Segmented, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";

type Network = "bitcoin" | "mutinynet" | "signet" | "regtest";
/** Where each network's wallet connects unless someone types another provider. */
const NETWORKS: Record<Network, { label: string; provider: string; explorer: string }> = {
 bitcoin: { label: "Bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api" },
 mutinynet: { label: "Mutinynet", provider: "https://mutinynet.arkade.sh", explorer: "https://mutinynet.com/api" },
 signet: { label: "Signet", provider: "https://signet.arkade.sh", explorer: "https://mempool.space/signet/api" },
 regtest: { label: "Regtest", provider: "http://127.0.0.1:43010", explorer: "http://127.0.0.1:43000/api" },
};
/** Ark payments cost nothing today; the cap only stops a surprise, and the review shows the real fee. */
const feeCap = (amount: number) => Math.max(100, Math.ceil(amount / 100));

export function ArkWalletPanel({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
 const ark = state.ark;
 const { busy, error, run } = useRun();
 const [action, setAction] = useState<Action>("receive");
 const [via, setVia] = useState<"ark" | "onchain">("ark");
 const [address, setAddress] = useState(""), [amount, setAmount] = useState(""), [review, setReview] = useState<Review | null>(null);
 const [password, setPassword] = useState("");
 const [custom, setCustom] = useState(false), [provider, setProvider] = useState(""), [explorer, setExplorer] = useState("");
 const network = (ark?.network ?? "bitcoin") as Network;
 const test = network !== "bitcoin";
 const unit = test ? "test sats" : "sats";
 const ready = !!ark?.configured && !ark.locked;
 const intents = (state.intents ?? []).filter(i => i.method === "arkade");
 const stuck = !!ark?.configured && !!ark.automatic && !ready;
 const canReplace = intents.length === 0 && (stuck || (ready && ark.balance === 0));
 const use = (next: Network, params: { provider?: string; explorer?: string; mnemonic?: string } = {}) => wallet.arkCreate({ network: next, provider: params.provider ?? NETWORKS[next].provider, explorer: params.explorer ?? NETWORKS[next].explorer, mnemonic: params.mnemonic });

 return <div className="space-y-6" data-testid="ark-wallet">
  {!ark?.configured || (ark.locked && ark.automatic) ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="ark-connecting"><p className="text-text-primary">Connecting your Ark wallet…</p><Notice>{ark?.error ?? "This takes a few seconds the first time."}</Notice></div>
  : !ready ? <Section title="Unlock"><Row label="This wallet was created with a password"><input aria-label="Ark wallet password" type="password" autoComplete="current-password" className={input} value={password} onChange={e => setPassword(e.target.value)} /><Button variant="primary" disabled={busy} onClick={() => void run(async () => { await wallet.arkUnlock(password); setPassword(""); })}>Unlock Ark</Button></Row></Section>
  : <div className="space-y-4">
   <p className="text-text-primary" data-testid="ark-balance"><span className="text-4xl font-semibold tabular-nums">{ark.balance.toLocaleString()}</span><span className="text-text-muted text-sm ml-2">{unit}</span>{test && <span className="block text-xs text-yellow-500 mt-1">{NETWORKS[network].label} · test coins, worthless</span>}</p>
   <Actions value={action} onChange={setAction} />
   {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
    <Segmented label="Receive on" value={via} onChange={setVia} options={[{ value: "ark", label: "Ark (instant)" }, { value: "onchain", label: "Bitcoin on-chain" }]} />
    {via === "ark" ? <Address value={ark.address} testId="ark-address" note="Arrives by itself." />
     : <Address value={ark.boardingAddress} qr={ark.boardingAddress ? `bitcoin:${ark.boardingAddress}` : undefined} testId="ark-boarding-address" note={network === "regtest" ? "On a local regtest server, deposits are settled into Ark manually." : "Send from any Bitcoin wallet. Once confirmed it moves into Ark by itself; that needs Ghostly open."} />}
   </div>}
   {/* Outputs whose batch expired before renewal are still this wallet's: say so, and bring them back. */}
   {!!ark.recoverable && <div className="flex items-center gap-3 rounded-xl bg-yellow-500/10 px-3 py-2" data-testid="ark-recoverable">
    <p className="flex-1 text-xs text-yellow-500">{ark.recoverable.toLocaleString()} {unit} expired before they were renewed. They are still yours: recover them to use them again.</p>
    <Button data-testid="ark-recover" disabled={busy} onClick={() => void run(() => wallet.arkRecover())}>{busy ? "Recovering…" : "Recover"}</Button>
   </div>}
   {!!ark.incoming && <Notice tone="warning" testId="ark-incoming">{ark.incoming.toLocaleString()} {unit} on the way from an on-chain deposit</Notice>}
   {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
    <input aria-label="Ark recipient address" placeholder="Recipient Ark address" spellCheck={false} className={`${input} font-mono text-xs`} value={address} onChange={e => setAddress(e.target.value.trim())} />
    <Amount value={amount} onChange={setAmount} unit={unit} />
    <Button variant="primary" className="w-full" disabled={busy || !!review || !ark.balance || !address || !Number(amount)} onClick={() => void run(async () => { setReview(await wallet.preparePayment({ target: { method: "arkade", network: ark.network!, provider: ark.provider!, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 5 * 60 * 1000 }, amount: Number(amount), feeCap: feeCap(Number(amount)), payee: address })); })}>{ark.balance ? "Review payment" : "No balance to send yet"}</Button>
    <Notice>Nothing leaves before you approve.</Notice>
   </div>}
   {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
   {intents.filter(i => i.id !== review?.id).map(i => <Button key={i.id} className="block w-full text-left" onClick={() => setReview(i)}>{i.amount.toLocaleString()} sats · {i.state}</Button>)}
  </div>}
  {error && <Notice tone="error">{error}</Notice>}
  {ark?.error && ready && <Notice tone="warning">{ark.error}</Notice>}

  {(ready || stuck) && <Section title="Settings">
   {/* Mainnet is Bitcoin only; the test networks are the Testnet mode's (switch at the top of the wallet). */}
   {state.mode === "testnet" && <Row label="Network" hint={stuck ? "This network is not answering. You can switch to another one." : canReplace ? "Test networks use worthless coins." : "Only while this wallet is empty and has no payments."}>
    <Segmented label="Ark network" value={network} disabled={busy || !canReplace} options={(Object.keys(NETWORKS) as Network[]).filter(value => value !== "bitcoin").map(value => ({ value, label: NETWORKS[value].label }))} onChange={next => void run(() => use(next))} />
   </Row>}
   {ready && <><Row label="Provider" hint={ark.provider}><Button disabled={!canReplace} onClick={() => { setCustom(!custom); setProvider(ark.provider ?? ""); setExplorer(NETWORKS[network].explorer); }}>{custom ? "Cancel" : "Change"}</Button></Row>
   {custom && <Block>
    <input aria-label="Ark provider" className={`${input} font-mono text-xs`} value={provider} onChange={e => setProvider(e.target.value)} spellCheck={false} />
    <input aria-label="Bitcoin explorer API" className={`${input} font-mono text-xs`} value={explorer} onChange={e => setExplorer(e.target.value)} spellCheck={false} />
    <Button variant="primary" disabled={busy} onClick={() => void run(async () => { await use(network, { provider, explorer }); setCustom(false); })}>Use this provider</Button>
   </Block>}
   <Row label="Automatic renewal" hint={network === "regtest" ? "Off on regtest" : "While Ghostly is open"}><span className="text-sm text-text-secondary">{network === "regtest" ? "Off" : "On"}</span></Row>
   <BackupRows name="Ark" busy={busy} run={run} canReplace={canReplace}
    reveal={async () => (await wallet.arkBackup()).mnemonic} exportBackup={pw => wallet.arkExportBackup(pw)}
    restorePhrase={mnemonic => use(network, { provider: ark.provider, explorer: NETWORKS[network].explorer, mnemonic })} restoreFile={(text, pw) => wallet.arkRestoreBackup(text, pw)} /></>}
  </Section>}
 </div>;
}
