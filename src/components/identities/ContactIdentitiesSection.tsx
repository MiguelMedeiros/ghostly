import { useNavigate } from "react-router-dom";
import { useI18n } from "../../contexts/I18nContext";
import { categoryLabel, chatsByPeer, contactName, currentStatus, dateTime, providerLabel, RECEIVED_STATUS, shortSubject, useEngineState } from "../../lib/identities";
import { chatPath } from "../../lib/url";
import { Button, Row, Section } from "../wallet/ui";
import { ProviderMark, StatusPill } from "./ProviderMark";

/** What needs a look comes first: a revoked or unconfirmed proof, then the verified ones, then the rest. */
const ORDER: Record<string, number> = { revoked: 0, unconfirmed: 0, verified: 1 };

/**
 * Identities → From your contacts: every identity a contact shared, in every chat, with its status as this
 * app checked it. The details and Check again stay in that chat's Identities; this is the overview.
 */
export function ContactIdentitiesSection() {
  const state = useEngineState();
  const navigate = useNavigate();
  const { t } = useI18n();
  const links = (state?.links ?? []).filter(link => link.identities?.received.length);
  const chats = links.length ? chatsByPeer() : new Map();
  const received = links.flatMap(link => {
    const chat = chats.get(link.peerPubKeyZ32);
    return link.identities!.received.map(r => ({ r, status: currentStatus(r), chat, name: contactName(chat) ?? t("common.anonymous") }));
  }).sort((a, b) => (ORDER[a.status] ?? 2) - (ORDER[b.status] ?? 2));
  if (!received.length) return null;
  return (
    <Section title="From your contacts" testId="identities-received">
      {received.map(({ r, status, chat, name }) => (
        <Row key={`${chat?.id}/${r.id}`} testId="identity-received" leading={<ProviderMark provider={r.provider} subject={r.subject} />}
          label={<span className="flex flex-wrap items-center gap-2"><span>{name}</span><StatusPill ok={status === "verified"} warn={status === "revoked" || status === "unconfirmed"} testId="identity-received-status">{RECEIVED_STATUS[status]}</StatusPill></span>}
          hint={<>
            <span>{providerLabel(r.provider)} · <span className="font-mono break-all" title={r.subject}>{shortSubject(r.provider, r.subject)}</span></span>
            <span className="block">{categoryLabel(r.provider, r.verified.attester)} · checked {dateTime(r.checkedAt)}</span>
          </>}>
          {chat && <Button data-testid="identity-received-open" onClick={() => navigate(chatPath(chat.id))}>Open chat</Button>}
        </Row>
      ))}
    </Section>
  );
}
