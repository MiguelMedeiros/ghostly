import { formatPaymentAmount } from "@ghostly/core";
import type { GroupPayNote, GroupView } from "@ghostly/browser/shared/types";
import { RAIL, groupPayStatus, groupPayTitle } from "../lib/groupPayments";

const amountOf = (note: GroupPayNote) => note.decimals
  ? `${formatPaymentAmount(Number(note.amount), note.decimals)} ${note.unit === "testusdt" ? "test USDT" : "USDT"}`
  : `${Number(note.amount).toLocaleString()} ${note.test ? "test sats" : "sats"}`;

/**
 * A payment between two members, as everyone in the group sees it: who pays whom, how much, over what, and how it
 * stands. Nothing here can pay it: the two members have the real bubble, over their own edge.
 */
export function GroupPaymentNote({ note, group }: { note: GroupPayNote; group: GroupView }) {
  const status = groupPayStatus(note, group);
  return <div data-testid="group-pay-note" data-state={status.state} data-id={note.id} className="flex justify-center mb-3.5 px-6">
    <div className="w-full max-w-xs rounded-xl border border-border bg-surface-alt/95 px-3 py-2 text-text-primary shadow-sm">
      <p className="m-0 text-[11px] uppercase tracking-wider text-text-muted" data-testid="group-pay-note-title">{groupPayTitle(note, group)}</p>
      <p className="m-0 leading-tight"><span className="text-lg font-semibold">{amountOf(note)}</span></p>
      <p className="m-0 text-[11px] text-text-muted">{RAIL[note.rail]}</p>
      {note.memo && <p className="m-0 mt-0.5 text-[13px] break-words">{note.memo}</p>}
      <p data-testid="group-pay-note-state" className={`m-0 mt-1 text-[11px] ${status.state === "paid" ? "text-accent" : status.state === "closed" ? "text-danger" : "text-text-muted"}`}>{status.text}</p>
    </div>
  </div>;
}

/** Under a member's own payment bubble: who it was with, and, for a request to the group, who paid it. */
export function GroupPaymentCaption({ note, group }: { note: GroupPayNote; group: GroupView }) {
  const status = groupPayStatus(note, group);
  return <p data-testid="group-pay-caption" data-state={status.state} className="-mt-2.5 mb-3 px-6 text-center text-[11px] text-text-muted">
    {groupPayTitle(note, group)} · {status.text}
  </p>;
}
