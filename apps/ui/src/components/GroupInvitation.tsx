import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useI18n } from "../contexts/I18nContext";
import type { Translate } from "../locales/translate";

/** How long the reason an answer did not go stays under Accept and Decline. */
export const REFUSAL_SHOWN_MS = 8000;

type Invitation = NonNullable<GroupView["invitation"]>;

/** A contact's invitation in one line: who invited and to how many, or where the answer is. */
export function invitationLine(invitation: Invitation, t: Translate): string {
  const members = invitation.members === 1 ? t("group.chat.memberOne") : t("group.chat.memberCount", { count: invitation.members });
  return invitation.takenBack ? t("sidebar.group.takenBack") : invitation.unanswered ? t("sidebar.group.unanswered") : invitation.accepted ? t("group.chat.joining")
    : invitation.contact ? t("sidebar.group.invitedBy", { contact: invitation.contact, members }) : t("sidebar.group.invitedByUnknown", { members });
}

/** Whether Accept and Decline are offered: not answered yet, or accepted with no answer from the inviter's app. Not once taken back. */
export const answerable = (invitation: Invitation | undefined) => !!invitation && !invitation.takenBack && (!invitation.accepted || !!invitation.unanswered);

/** Who took the invitation back, and what to do: the words of a taken-back invitation's page. */
function takenBackWords(group: GroupView, t: Translate): { title: string; next: string } {
  const contact = group.invitation!.contact, name = group.name || t("group.chat.unnamed");
  return contact ? { title: t("group.chat.takenBack", { contact, name }), next: t("group.chat.takenBackNext", { contact }) }
    : { title: t("group.chat.takenBackUnknown", { name }), next: t("group.chat.takenBackNextUnknown") };
}

/**
 * Accept or Decline, from the invitation's row or its own page. Accept needs the inviter's chat live, which takes a
 * moment after the app opens: why the last answer did not go is said for a few seconds, since a click that did nothing
 * and said nothing looked broken.
 */
export function useInvitationAnswer(group: GroupView) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setRefused(null), REFUSAL_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [refused]);
  const answer = async (method: "acceptGroupInvitation" | "declineGroupInvitation") => {
    setBusy(true);
    setRefused(null);
    try { await engine.call(method, { groupId: group.id }); } catch (error) {
      const away = /not connected/i.test(error instanceof Error ? error.message : String(error));
      const contact = group.invitation?.contact;
      setRefused(!away ? t("sidebar.group.answerFailed") : contact ? t("sidebar.group.inviterAway", { contact }) : t("sidebar.group.inviterAwayUnknown"));
    } finally { setBusy(false); }
  };
  return { busy, refused, answer };
}

/** Accept and Decline, small (a chat list row) or a thumb's height (the invitation's own page). */
export function InvitationButtons({ busy, answer, large = false }: Pick<ReturnType<typeof useInvitationAnswer>, "busy" | "answer"> & { large?: boolean }) {
  const { t } = useI18n();
  const size = large ? "min-h-11 px-5 text-sm" : "px-3 py-1 text-xs";
  return <>
    <button disabled={busy} data-testid="group-accept" onClick={e => { e.stopPropagation(); void answer("acceptGroupInvitation"); }}
      className={`rounded-lg bg-accent font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40 ${size}`}>{t("chat.file.accept")}</button>
    <button disabled={busy} data-testid="group-decline" onClick={e => { e.stopPropagation(); void answer("declineGroupInvitation"); }}
      className={`rounded-lg text-text-secondary hover:bg-surface-hover disabled:opacity-40 ${size}`}>{t("chat.file.decline")}</button>
  </>;
}

/** A taken-back invitation's only action: Delete (it says nothing to whoever took it back). */
export function TakenBackDelete({ busy, answer, large = false }: Pick<ReturnType<typeof useInvitationAnswer>, "busy" | "answer"> & { large?: boolean }) {
  const { t } = useI18n();
  return <button disabled={busy} data-testid="group-taken-back-delete" onClick={e => { e.stopPropagation(); void answer("declineGroupInvitation"); }}
    className={`rounded-lg text-text-secondary hover:bg-surface-hover disabled:opacity-40 ${large ? "min-h-11 px-5 text-sm" : "px-3 py-1 text-xs"}`}>{t("common.delete")}</button>;
}

/**
 * A contact's invitation on its own page (opened from its row, on a phone the only way in): who invited and to what,
 * with Accept and Decline, as the row says it. It was an empty chat with a field that took nothing. `compact`: a band
 * over the history kept from before, for a member invited back.
 */
export function GroupInvitationCard({ group, compact = false }: { group: GroupView; compact?: boolean }) {
  const { t } = useI18n();
  const { busy, refused, answer } = useInvitationAnswer(group);
  const invitation = group.invitation!;
  const buttons = invitation.takenBack ? <TakenBackDelete busy={busy} answer={answer} large /> : answerable(invitation) && <InvitationButtons busy={busy} answer={answer} large />;
  // Taken back by who sent it: who did, and what to do, where the invitation was.
  const taken = invitation.takenBack ? takenBackWords(group, t) : undefined;
  const line = taken ? <span data-testid="group-taken-back"><span className="block font-medium text-text-primary">{taken.title}</span>{taken.next}</span> : invitationLine(invitation, t);
  const why = refused && <p role="status" data-testid="group-answer-refused" className="text-xs text-danger">{refused}</p>;
  if (compact) return <div data-testid="group-invitation" className="border-b border-border bg-surface-alt px-4 py-2 text-xs text-text-secondary">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0">{line}</p>
      {buttons && <div className="flex shrink-0 gap-2">{buttons}</div>}
    </div>
    {why && <div className="mt-1">{why}</div>}
  </div>;
  return <div className="flex flex-1 items-center justify-center overflow-y-auto chat-wallpaper px-4">
    <div data-testid="group-invitation" className="w-full max-w-sm rounded-2xl border border-border bg-sidebar-bg/95 p-6 text-center shadow-xl">
      <h2 className="break-words text-base font-semibold text-text-primary">{group.name || t("group.chat.unnamed")}</h2>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">{line}</p>
      {buttons && <div className="mt-4 flex justify-center gap-2">{buttons}</div>}
      {why && <div className="mt-3">{why}</div>}
    </div>
  </div>;
}
