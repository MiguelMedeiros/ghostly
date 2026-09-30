import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { groupPath } from "../../lib/groups";
import { useEngineState } from "../../lib/identities";
import { showJoinNotice } from "../../lib/joinNotice";
import { ensureSession } from "../../lib/storage";
import { INVITE_REFUSAL_MESSAGE, chatPath, classifyInvite, readInvite, type JoinOutcome } from "../../lib/url";
import { CardIcon, EntityCardFrame, cardButton, cardQuiet } from "./EntityCardFrame";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Who the card says handed the invite over: the contact who sent it (by name, when known), or you. */
function fromLine(t: Translate, mine: boolean, from: string | undefined): string {
  if (mine) return t("chat.entity.youSent");
  return from ? t("chat.entity.fromName", { name: from }) : t("chat.entity.fromContact");
}

/** What joining would do in this profile now: read from stored chats only, nothing on the network. */
function outcomeOf(code: string): JoinOutcome | null {
  const reading = readInvite(code);
  return reading.ok ? classifyInvite(reading.keys) : null;
}

/**
 * A `ghostly1…` invite in a message. Nothing happens until a tap on Join, which runs the Join dialog's rules again at
 * that moment: this profile's own invite is refused (WISP 801 Q9) with the way to the chat that owns it, one already
 * joined by opens its chat, a new one makes the chat and opens it.
 */
export function InviteEntityCard({ code, mine, from }: { code: string; mine: boolean; from?: string }) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const [outcome, setOutcome] = useState(() => outcomeOf(code));
  const [error, setError] = useState("");
  useEffect(() => {
    const update = () => setOutcome(outcomeOf(code));
    update();
    window.addEventListener("session-updated", update);
    return () => window.removeEventListener("session-updated", update);
  }, [code]);

  const join = () => {
    setError("");
    const reading = readInvite(code);
    if (!reading.ok) { setError(t(INVITE_REFUSAL_MESSAGE[reading.reason])); return; }
    const now = classifyInvite(reading.keys);
    setOutcome(now);
    if (now.kind === "own") return;
    if (now.kind === "joined") { showJoinNotice("join.alreadyIn"); nav.conversation(chatPath(now.sessionId)); return; }
    let sessionId: string;
    try { sessionId = ensureSession(reading.keys); } catch { setError(t("join.invalid")); return; }
    window.dispatchEvent(new Event("session-updated"));
    nav.conversation(chatPath(sessionId));
  };

  return (
    <EntityCardFrame testId="entity-invite" data={{ "data-outcome": outcome?.kind ?? "invalid" }} label={t("chat.entity.chatInvite")}
      mark={<CardIcon><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M12 7v6M9 10h6" /></CardIcon>}
      title={outcome?.kind === "own" ? t("chat.entity.yourInvite") : t("chat.entity.privateInvite")} subtitle={fromLine(t, mine, from)}>
      {outcome?.kind === "own" ? <>
        <p role="note" data-testid="entity-invite-own" className="m-0">{t("join.own")}</p>
        <button type="button" data-testid="entity-invite-open" className={cardQuiet} onClick={() => nav.conversation(chatPath(outcome.sessionId))}>{t("join.openChat")}</button>
      </> : outcome?.kind === "joined" ? <>
        <p className="m-0" data-testid="entity-invite-joined">{t("join.alreadyIn")}</p>
        <button type="button" data-testid="entity-invite-open" className={cardQuiet} onClick={join}>{t("join.openChat")}</button>
      </> : <>
        <p className="m-0">{t("chat.entity.joinHint")}</p>
        <button type="button" data-testid="entity-invite-join" className={cardButton} onClick={join}>{t("chat.entity.join")}</button>
      </>}
      {error && <p role="alert" className="m-0 text-danger-ink">{error}</p>}
    </EntityCardFrame>
  );
}

/**
 * A group's link (`group1/…`) or a community group's (`group2/…`) in a message. A tap on Join group knocks through
 * the link like the Join dialog does and opens the group, which says it waits for the admin's app; a group this profile
 * is already in just opens.
 */
export function GroupEntityCard({ link, community, groupId, mine, from }: { link: string; community: boolean; groupId: string; mine: boolean; from?: string }) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const state = useEngineState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // An invitation not yet answered is not membership: it has no status until it is.
  const group = state?.groups.find(g => g.id === groupId && g.status);
  const join = async () => {
    setError(""); setBusy(true);
    try {
      const { groupId: id } = await engine.call("joinGroupByLink", { link });
      nav.conversation(groupPath(id));
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return (
    <EntityCardFrame testId="entity-group" data={{ "data-community": community ? "true" : undefined, "data-member": group ? "true" : undefined }}
      label={community ? t("chat.entity.communityGroup") : t("chat.entity.groupInvite")}
      mark={<CardIcon><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.4" /><path d="M16 14.2c2.8.3 5 2.6 5 5.8" /></CardIcon>}
      title={group?.name || (community ? t("chat.entity.aCommunity") : t("chat.entity.aPrivateGroup"))} subtitle={fromLine(t, mine, from)}>
      {group ? <>
        <p className="m-0" data-testid="entity-group-member">{t("chat.entity.inGroup")}</p>
        <button type="button" data-testid="entity-group-open" className={cardQuiet} onClick={() => nav.conversation(groupPath(group.id))}>{t("chat.entity.openGroup")}</button>
      </> : <>
        <p className="m-0">{community ? t("chat.entity.communityHint") : t("chat.entity.groupHint")}</p>
        <button type="button" data-testid="entity-group-join" disabled={busy} className={cardButton} onClick={() => void join()}>{busy ? t("chat.entity.joining") : t("chat.entity.joinGroup")}</button>
      </>}
      {error && <p role="alert" className="m-0 text-danger-ink">{error}</p>}
    </EntityCardFrame>
  );
}
