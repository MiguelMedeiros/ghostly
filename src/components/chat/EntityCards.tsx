import { useMemo } from "react";
import { MAX_ENTITY_CARDS, entityKey, findEntities } from "../../lib/parse/entities";
import { IdentityEntityCard } from "./EntityCardIdentity";
import { GroupEntityCard, InviteEntityCard } from "./EntityCardInvite";
import { NostrEntityCard } from "./EntityCardNostr";

/**
 * The cards under a text message, one per invite, group link, Nostr code or identity it names (see
 * `lib/parse/entities.ts`), the text itself left as it is. `from` is the sender's name when the message is a
 * contact's; `peerPubKey` is the chat's contact, whose proofs come first on an identity card.
 */
export function EntityCards({ text, mine, from, peerPubKey }: { text: string; mine: boolean; from?: string; peerPubKey?: string }) {
  const entities = useMemo(() => findEntities(text).slice(0, MAX_ENTITY_CARDS), [text]);
  if (entities.length === 0) return null;
  return (
    <div data-testid="entity-cards" className="clear-both">
      {entities.map(e => {
        const key = entityKey(e);
        switch (e.kind) {
          case "invite": return <InviteEntityCard key={key} code={e.code} mine={mine} from={from} />;
          case "group": return <GroupEntityCard key={key} link={e.link} community={e.community} groupId={e.groupId} mine={mine} from={from} />;
          case "nostr": return <NostrEntityCard key={key} code={e.code} pointer={e.pointer} />;
          case "identity": return <IdentityEntityCard key={key} provider={e.provider} subject={e.subject} peerPubKey={peerPubKey} />;
        }
      })}
    </div>
  );
}
