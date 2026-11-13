import type { GroupPayNote, GroupView } from "@ghostly/browser/shared/types";
import type { Translate } from "../contexts/I18nContext";
import { english } from "./english";
import { memberName, othersName, sameNamed } from "./groups";

export const RAIL = { cashu: "Cashu", lightning: "Lightning", arkade: "Ark", bark: "Bark", spark: "Spark", bitcoin: "Bitcoin on-chain", usdt: "USDT", fedimint: "Fedimint" } as const;
/** A rail's name in the app's language: brand names as they are, "Bitcoin on-chain" in words. */
export const railName = (rail: keyof typeof RAIL, t: Translate = english): string => rail === "bitcoin" ? t("payments.group.bitcoinOnchain") : RAIL[rail];

/** A member as the group knows them now; someone no longer in it, by what is left. `capital`: at the start of a sentence. */
function who(group: GroupView, key: string, t: Translate, capital = true): string {
  const member = group.members.find(m => m.key === key);
  if (!member) return t(capital ? "payments.group.formerMember" : "payments.group.formerMemberObject");
  return member.me ? t(capital ? "payments.group.you" : "payments.group.youObject") : othersName(memberName(member, t, sameNamed(group.members)), t);
}

/**
 * Who pays whom, in the group's words. When I am the payer or the payee the line is a sentence of its own: "You" slotted
 * into "{{from}} is paying {{to}}" reads "You is paying Alice", and "Vous a demandé à Bob" or "Tú pidió a Bob" elsewhere.
 */
export function groupPayTitle(note: GroupPayNote, group: GroupView, t: Translate = english): string {
  const mine = (key: string) => group.members.some(m => m.me && m.key === key);
  const fromMe = mine(note.from), toMe = mine(note.to);
  if (note.kind === "payment") return fromMe ? t("payments.group.title.sentByMe", { to: who(group, note.to, t, false) })
    : toMe ? t("payments.group.title.sentToMe", { from: who(group, note.from, t) })
    : t("payments.group.title.sent", { from: who(group, note.from, t), to: who(group, note.to, t, false) });
  if (note.from === "*") return toMe ? t("payments.group.title.askedGroupByMe") : t("payments.group.title.askedGroup", { to: who(group, note.to, t) });
  // An ask: the payer started it, the payee answered with where to pay.
  if (note.ask) return fromMe ? t("payments.group.title.payingByMe", { to: who(group, note.to, t, false) })
    : toMe ? t("payments.group.title.payingMe", { from: who(group, note.from, t) })
    : t("payments.group.title.paying", { from: who(group, note.from, t), to: who(group, note.to, t, false) });
  return toMe ? t("payments.group.title.askedByMe", { from: who(group, note.from, t, false) })
    : fromMe ? t("payments.group.title.askedMe", { to: who(group, note.to, t) })
    : t("payments.group.title.asked", { to: who(group, note.to, t), from: who(group, note.from, t, false) });
}

/** Where it stands: `data-state` and the words. */
export function groupPayStatus(note: GroupPayNote, group: GroupView, t: Translate = english): { state: "open" | "sent" | "paid" | "closed"; text: string } {
  // A request to the group paid through an invoice names nobody: its payee cannot tell who paid (a note an older app
  // kept may still carry a name).
  if (note.state === "paid") return { state: "paid", text: note.by && note.from === "*" && note.rail !== "lightning" ? t("payments.group.status.paidBy", { name: who(group, note.by, t, false) }) : t("payments.group.status.paid") };
  if (note.state === "closed") return { state: "closed", text: t(note.kind === "payment" ? "payments.group.status.takenBack" : "payments.group.status.closed") };
  const claims = note.claims ?? [];
  if (note.kind === "request" && claims.length) {
    const names = claims.map(k => who(group, k, t)).join(t("payments.group.listSeparator"));
    const one = claims.length === 1 && claims[0] !== group.myKey;
    return { state: "sent", text: t(one ? "payments.group.status.saysPaid" : "payments.group.status.claimedPaid", { names, to: who(group, note.to, t, false) }) };
  }
  if (note.kind === "payment" || note.state === "sent") return { state: "sent", text: t("payments.group.status.sent", { name: who(group, note.to, t, false) }) };
  return { state: "open", text: t("payments.group.status.waiting") };
}
