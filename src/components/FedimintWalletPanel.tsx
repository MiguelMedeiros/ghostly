import { useState } from "react";
import { paymentUri } from "@ghostly/core";
import type { FederationInfo } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, input, type Action } from "./wallet/ui";
import { useRun, downloadJson } from "./wallet/run";
import { Select } from "./ui/Select";
import { pageUnit } from "./walletCardData";

const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const KIND: Record<string, string> = { "notes-out": "Notes sent", "notes-in": "Notes received", "lightning-in": "Lightning received", "lightning-out": "Lightning paid", onchain: "On-chain" };
const STATE: Record<string, string> = { pending: "pending", done: "done", failed: "failed", "taken-back": "taken back" };

/** What a federation says about itself, before and after joining it. */
function FederationFacts({ info, testId }: { info: Pick<FederationInfo, "federationId" | "name" | "guardians" | "consensusVersion" | "network" | "modules" | "welcome">; testId: string }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid={testId}>
    <dt className="text-text-muted">Name</dt><dd className="text-text-primary" data-testid={`${testId}-name`}>{info.name ?? "(none given)"}</dd>
    <dt className="text-text-muted">Id</dt><dd className="font-mono text-text-secondary break-all">{info.federationId}</dd>
    <dt className="text-text-muted">Network</dt><dd className="text-text-secondary" data-testid={`${testId}-network`}>{info.network ?? "unknown"}</dd>
    <dt className="text-text-muted">Guardians</dt><dd className="text-text-secondary" data-testid={`${testId}-guardians`}>{info.guardians.length}: {info.guardians.map((g) => g.name).join(", ")}</dd>
    <dt className="text-text-muted">Consensus</dt><dd className="text-text-secondary">v{info.consensusVersion} · modules {info.modules.join(", ")}</dd>
    {info.welcome && <><dt className="text-text-muted">Says</dt><dd className="text-text-secondary">{info.welcome}</dd></>}
  </dl>;
}

/**
 * Federations joined with an invite code, and their ecash. Receive: an invoice paid through the federation's
 * gateway, or notes someone handed over. Send: notes to hand over (they come back if nobody redeems them).
 */
export function FedimintWalletPanel({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
  const fm = state.fedimint;
  const { busy, error, setError, run } = useRun();
  const federations = fm?.federations ?? [];
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const current = federations.find((f) => f.id === selected) ?? federations.find((f) => f.status === "ready") ?? federations[0];
  const [action, setAction] = useState<Action>("receive");
  const [invite, setInvite] = useState(""), [preview, setPreview] = useState<FederationInfo | null>(null), [joining, setJoining] = useState(false);
  const [amount, setAmount] = useState(""), [invoice, setInvoice] = useState(""), [notesIn, setNotesIn] = useState(""), [received, setReceived] = useState("");
  const [notesOut, setNotesOut] = useState<{ notes: string; operation: string; federation: string } | null>(null);
  const [restoreInvites, setRestoreInvites] = useState(""), [phrase, setPhrase] = useState(""), [shownPhrase, setShownPhrase] = useState("");
  const [password, setPassword] = useState(""), [file, setFile] = useState(""), [filePassword, setFilePassword] = useState(""), [open, setOpen] = useState<"none" | "backup" | "restore">("none");
  const test = current ? current.network !== "bitcoin" : state.mode === "testnet";
  const unit = pageUnit(state, test);
  const ready = current?.status === "ready";
  const lnSource = state.lightning?.providerId === "fedimint";

  if (fm?.unavailable) return <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="fedimint-wallet"><p className="text-text-primary">Fedimint is Testnet only for now</p><Notice testId="fedimint-unavailable">{fm.unavailable}</Notice></div>;

  const join = <Section title={federations.length ? "Join another federation" : "Join a federation"}>
    <Block>
      <p className="text-xs text-text-muted">A federation is a group of guardians who hold the bitcoin together and issue ecash for it. Joining one is trusting them with what you keep there. Paste its invite code (fed1…).</p>
      <textarea aria-label="Federation invite code" data-testid="fedimint-invite" rows={2} spellCheck={false} placeholder="fed1…" className={`${input} font-mono text-xs resize-none`} value={invite}
        onChange={(e) => { setInvite(e.target.value.trim()); setPreview(null); }} />
      {!preview ? <Button data-testid="fedimint-preview" disabled={busy || !invite} onClick={() => void run(async () => setPreview(await wallet.fedimintPreview(invite)))}>{busy ? "Asking its guardians…" : "Look at this federation"}</Button>
        : <div className="space-y-3">
          <FederationFacts info={preview} testId="fedimint-preview-facts" />
          {!preview.modules.includes("ln") && <Notice tone="warning">No Lightning gateway module: ecash in and out as notes only.</Notice>}
          <div className="flex gap-2">
            <Button variant="primary" data-testid="fedimint-join" disabled={busy || joining} onClick={() => { setJoining(true); void run(async () => { const joined = await wallet.fedimintJoin(invite); setSelected(joined.id); setInvite(""); setPreview(null); }).finally(() => setJoining(false)); }}>{joining ? "Joining…" : `Join ${preview.name ?? "this federation"}`}</Button>
            <Button onClick={() => setPreview(null)}>Cancel</Button>
          </div>
        </div>}
    </Block>
  </Section>;

  return <div className="space-y-6" data-testid="fedimint-wallet">
    {!federations.length ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="fedimint-empty"><p className="text-text-primary">No federation yet</p><Notice>Join one with its invite code below. Nothing is joined for you: you choose whom to trust.</Notice></div>
    : <div className="space-y-4">
      {federations.length > 1 && <Select aria-label="Federation" value={current?.id ?? ""} onChange={(id) => { setSelected(id); setInvoice(""); setNotesOut(null); }}
        options={federations.map((f) => ({ value: f.id, label: f.name ?? short(f.id), description: `${f.balance.toLocaleString()} ${unit}` }))} />}
      {current && <>
        <p className="text-text-primary" data-testid="fedimint-balance"><span className="text-4xl font-semibold tabular-nums">{current.balance.toLocaleString()}</span><span className="text-text-muted text-sm ml-2">{unit}</span>
          <span className={`block text-xs mt-1 ${test ? "text-yellow-500" : "text-text-muted"}`}>{current.name ?? short(current.id)} · {current.network ?? "unknown network"}{test ? " · test coins, worthless" : ""}</span></p>
        {current.status !== "ready" && <Notice tone={current.status === "error" ? "warning" : "muted"} testId="fedimint-status">{current.status === "error" ? `Not answering: ${current.error ?? "unknown error"}` : "Connecting to the federation…"}</Notice>}
        {federations.length > 1 && <Notice>{fm!.balance.toLocaleString()} {unit} across {federations.length} federations. Ecash of one federation is not ecash of another.</Notice>}
        <Actions value={action} onChange={(next) => { setAction(next); setError(""); }} actions={["receive", "send", "history"]} />
        {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
          {current.lightning && <>
            <p className="text-xs text-text-secondary">Lightning, through the federation's gateway: paid from any wallet, it arrives as ecash here.</p>
            <Amount value={amount} onChange={(v) => { setAmount(v); setInvoice(""); }} unit={unit} testId="fedimint-receive-amount" />
            {!invoice ? <Button variant="primary" className="w-full" data-testid="fedimint-receive-invoice" disabled={busy || !ready || !Number(amount)} onClick={() => void run(async () => setInvoice((await wallet.fedimintInvoice(current.id, Number(amount))).invoice))}>Create invoice</Button>
              : <Address value={invoice} uri={paymentUri({ kind: "lightning", invoice })} testId="fedimint-invoice" note="The balance goes up once it is paid (the gateway takes its fee)." />}
          </>}
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">Notes someone gave you (out-of-band ecash of a federation you joined):</p>
            <textarea aria-label="Fedimint notes to redeem" data-testid="fedimint-notes-in" rows={2} spellCheck={false} className={`${input} font-mono text-xs resize-none`} value={notesIn} onChange={(e) => { setNotesIn(e.target.value.trim()); setReceived(""); }} />
            <Button data-testid="fedimint-redeem" disabled={busy || !notesIn} onClick={() => void run(async () => { const r = await wallet.fedimintReceiveNotes(notesIn); setNotesIn(""); setReceived(`Redeemed ${r.amount.toLocaleString()} ${unit}.`); })}>Redeem</Button>
            {received && <Notice tone="success" testId="fedimint-redeemed">{received}</Notice>}
          </div>
        </div>}
        {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
          <p className="text-xs text-text-secondary">Notes are bearer ecash: whoever has the text can redeem it, once. If nobody does, take them back (they also come back by themselves after a week). In a chat, pay with the Fedimint card instead. To pay an invoice, make this federation the Lightning source (Settings below) and use the Lightning card.</p>
          <Amount value={amount} onChange={(v) => { setAmount(v); setNotesOut(null); }} unit={unit} testId="fedimint-send-amount" />
          {!notesOut ? <Button variant="primary" className="w-full" data-testid="fedimint-spend" disabled={busy || !ready || !Number(amount) || Number(amount) > current.balance} onClick={() => void run(async () => setNotesOut({ ...(await wallet.fedimintSpendNotes(current.id, Number(amount))), federation: current.id }))}>{Number(amount) > current.balance ? "More than this federation holds" : "Create notes"}</Button>
            : <div className="space-y-2">
              <Address value={notesOut.notes} testId="fedimint-notes-out" note="Hand this over privately: it is the money itself." />
              <Button data-testid="fedimint-take-back" disabled={busy} onClick={() => void run(async () => { const state = await wallet.fedimintTakeBack(notesOut.federation, notesOut.operation); if (state === "pending") throw new Error("The federation has not answered yet: try again"); setNotesOut(null); setReceived(state === "canceled" ? "Taken back." : "Already redeemed by someone."); })}>Take them back</Button>
            </div>}
        </div>}
        {action === "history" && <div className="bg-surface rounded-xl p-2 animate-fade-in" data-testid="fedimint-history">
          {!(fm?.history ?? []).length ? <p className="text-xs text-text-muted p-2">Nothing yet.</p> : (fm!.history.filter((tx) => federations.length < 2 || tx.federation === current.id)).map((tx) => (
            <div key={tx.id} className="flex items-center gap-3 px-2 py-2 text-sm border-b border-border last:border-0" data-testid="fedimint-tx">
              <span className="flex-1 text-text-primary">{KIND[tx.kind]}{tx.paymentId && !tx.paymentId.startsWith("wallet-") ? " · chat" : ""}</span>
              <span className="tabular-nums text-text-secondary">{tx.amount !== undefined ? `${tx.kind.endsWith("out") ? "−" : "+"}${tx.amount.toLocaleString()}` : ""}{tx.fee ? ` (fee ${tx.fee})` : ""}</span>
              <span className="text-xs text-text-muted w-20 text-right">{STATE[tx.state]}</span>
            </div>))}
        </div>}
        {received && action !== "receive" && <Notice tone="success">{received}</Notice>}
      </>}
    </div>}
    {error && <Notice tone="error">{error}</Notice>}
    {join}
    {federations.length > 0 && <Section title="Settings">
      {current && <>
        <Row label="This federation" hint={`${current.guardians.length} guardian${current.guardians.length === 1 ? "" : "s"} · consensus v${current.consensusVersion}`}><span className="text-xs font-mono text-text-secondary">{short(current.id)}</span></Row>
        <Block><FederationFacts info={{ ...current, federationId: current.id }} testId="fedimint-facts" /></Block>
        {current.lightning && <Row label="Lightning" hint={lnSource ? "The Lightning card goes through a federation's gateway" : "Make the Lightning card pay and receive through this federation"}>
          <Button data-testid="fedimint-use-lightning" disabled={busy || !ready} onClick={() => void run(() => wallet.lightningSetSource("fedimint", { federation: current.id }))}>{lnSource && state.lightning?.alias === current.name ? "In use" : "Use for Lightning"}</Button>
        </Row>}
        <Row label="Leave" hint="Only once it holds nothing and no payment is under way"><Button data-testid="fedimint-leave" disabled={busy || current.balance > 0} onClick={() => void run(() => wallet.fedimintLeave(current.id))}>Leave</Button></Row>
      </>}
      <Row label="Recovery phrase" hint="With the invite codes, it brings every federation's ecash back"><Button disabled={busy} onClick={() => shownPhrase ? setShownPhrase("") : void run(async () => setShownPhrase((await wallet.fedimintBackup()).mnemonic))}>{shownPhrase ? "Hide" : "Show"}</Button></Row>
      {shownPhrase && <Block><p className="select-all text-sm font-mono text-text-primary break-words" data-testid="fedimint-recovery">{shownPhrase}</p></Block>}
      <Row label="Wallet backup" hint="The phrase and the federations; the profile backup has everything"><Button onClick={() => setOpen(open === "backup" ? "none" : "backup")}>{open === "backup" ? "Cancel" : "Download"}</Button></Row>
      {open === "backup" && <Block>
        <input aria-label="Fedimint backup password" type="password" autoComplete="new-password" placeholder="Backup password (12+ characters)" className={input} value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button variant="primary" disabled={busy || password.length < 12} onClick={() => void run(async () => { downloadJson(await wallet.fedimintExportBackup(password), "ghostly-fedimint-backup.json"); setPassword(""); setOpen("none"); })}>Download</Button>
      </Block>}
    </Section>}
    <Section title="Restore">
      <Row label="From a backup" hint={federations.length ? "Only into a wallet mode with no federation yet" : "Every federation is joined again and recovers its ecash"}><Button disabled={!!federations.length && open !== "restore"} onClick={() => setOpen(open === "restore" ? "none" : "restore")}>{open === "restore" ? "Cancel" : "Restore"}</Button></Row>
      {open === "restore" && <Block>
        <textarea aria-label="Fedimint recovery phrase" rows={2} spellCheck={false} placeholder="Recovery phrase" className={`${input} font-mono resize-none`} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        <textarea aria-label="Invite codes to restore" rows={2} spellCheck={false} placeholder="Invite codes, one per line (fed1…)" className={`${input} font-mono text-xs resize-none`} value={restoreInvites} onChange={(e) => setRestoreInvites(e.target.value)} />
        <Button variant="primary" disabled={busy || !phrase.trim() || !restoreInvites.trim()} onClick={() => void run(async () => { const r = await wallet.fedimintRestorePhrase(phrase, restoreInvites.split(/\s+/).filter(Boolean)); setPhrase(""); setRestoreInvites(""); setOpen("none"); if (r.failed.length) throw new Error(`Restored ${r.joined}; could not restore: ${r.failed.join("; ")}`); })}>Restore from phrase</Button>
        <label className="block text-xs text-text-muted">…or an encrypted backup file
          <input type="file" accept="application/json,.json" className={`${input} mt-1`} onChange={(e) => { const f = e.target.files?.[0]; if (f && f.size <= 1024 * 1024) void f.text().then(setFile); }} />
        </label>
        {file && <><input aria-label="Fedimint backup file password" type="password" className={input} placeholder="Backup password" value={filePassword} onChange={(e) => setFilePassword(e.target.value)} />
          <Button variant="primary" disabled={busy || !filePassword} onClick={() => void run(async () => { const r = await wallet.fedimintRestoreBackup(file, filePassword); setFile(""); setFilePassword(""); setOpen("none"); if (r.failed.length) throw new Error(`Restored ${r.joined}; could not restore: ${r.failed.join("; ")}`); })}>Restore backup</Button></>}
        <Notice>The federations give the ecash back from the backups they keep for this phrase. Payments still in flight come back as unknown.</Notice>
      </Block>}
    </Section>
  </div>;
}
