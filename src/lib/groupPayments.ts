import type { GroupPayNote, GroupView } from "@ghostly/browser/shared/types";
import { memberName } from "./groups";

export const RAIL = { cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", bitcoin: "Bitcoin on-chain", usdt: "USDT" } as const;

/** A member as the group knows them now; someone no longer in it, by what is left. */
function who(group: GroupView, key: string, capital = true): string {
  const member = group.members.find(m => m.key === key);
  if (!member) return capital ? "A former member" : "a former member";
  return member.me ? (capital ? "You" : "you") : memberName(member);
}

/** Who pays whom, in the group's words. */
export function groupPayTitle(note: GroupPayNote, group: GroupView): string {
  if (note.kind === "payment") return `${who(group, note.from)} sent ${who(group, note.to, false)}`;
  if (note.from === "*") return `${who(group, note.to)} asked the group`;
  // An ask: the payer started it, the payee answered with where to pay.
  if (note.ask) return `${who(group, note.from)} is paying ${who(group, note.to, false)}`;
  return `${who(group, note.to)} asked ${who(group, note.from, false)}`;
}

/** Where it stands: `data-state` and the words. */
export function groupPayStatus(note: GroupPayNote, group: GroupView): { state: "open" | "sent" | "paid" | "closed"; text: string } {
  if (note.state === "paid") return { state: "paid", text: note.by && note.from === "*" ? `Paid by ${who(group, note.by, false)}` : "Paid" };
  if (note.state === "closed") return { state: "closed", text: note.kind === "payment" ? "Taken back" : "Closed" };
  const claims = note.claims ?? [];
  if (note.kind === "request" && claims.length)
    return { state: "sent", text: `${claims.map(k => who(group, k)).join(", ")} ${claims.length === 1 && claims[0] !== group.myKey ? "says they paid" : "paid"} · waiting for ${who(group, note.to, false)}'s wallet` };
  if (note.kind === "payment" || note.state === "sent") return { state: "sent", text: `Sent · waiting for ${who(group, note.to, false)}` };
  return { state: "open", text: "Waiting for payment" };
}

