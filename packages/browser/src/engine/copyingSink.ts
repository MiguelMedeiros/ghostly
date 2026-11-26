import { identityPicture, nostrPicture, type PictureAt } from "../shared/keptPictures";
import { isRefusalId } from "../shared/refusals";
import type { KeptPictures, KeptViews, PostedEvent } from "../shared/rpc";
import type { EngineState, GroupView, LinkView, StoredMessage } from "../shared/types";
import type { EngineClientSink } from "./server";

/**
 * A row as the extension's pages get it: without its details record (how it travelled, WISP 400 § Message details),
 * which the details view asks the engine for (`messageDetails`). It was 40% of an attach's bytes, and went again with
 * each history ask and each change. A row under a refusal's id keeps the frame it came in (`details.wire`): that is how
 * the page tells a contact's text from the engine's refusal line (`paymentRefusal`).
 */
function withoutDetails(message: StoredMessage): StoredMessage {
  if (message.details === undefined) return message;
  const { details, ...row } = message;
  return details.wire && isRefusalId(message.id) ? { ...row, details: { wire: details.wire } } : row;
}

/**
 * A client whose messages are copied on their way (the extension's port): every state used to carry every payment
 * this device kept and the whole wallet, copied each time, up to 20 times a second. `payments` and `wallet` are the
 * same objects until one changes (`PaymentBook`, `walletView`): a state whose own are the ones this client was sent
 * last leaves them out, and the page keeps those (`PostedState`). The first state always carries them.
 *
 * So does each picture: the profile's own, every contact's and every group's (a JPEG data URL each, up to 48 KB) were most
 * of a state's bytes, and went again with each one. One this client was sent last under the same name is left out
 * (`keptPictures`); a new one, or one back after a state without it, goes. The same for each public profile's picture
 * (up to 32 KB): this profile's verified identities' and Nostr keys', and each contact's.
 *
 * So does each chat's, group edge's and group's view: the engine builds them all again for each state, about one contact
 * typing too; a group's carries its whole member list, and a private group has an edge per member, each a whole chat
 * view with its transport log. One this client was sent last as it is now (its pictures left out the same way) is left
 * out, and the state names every chat's, edge's and group's id in order (`keptViews`): the page keeps the rest, and an
 * id no longer there is a chat, edge or group gone. A view that is the engine's same object as in the last state (it
 * keeps an unchanged chat's view, `pushedState`) is not written out again to tell, nor copied to leave its pictures out:
 * a file's progress sends a state every 250 ms, and writing out 2,000 chats' views cost ~8 ms per tab each time, copying
 * those with a picture ~2 ms more.
 *
 * A group whose view changed goes without its member list when that list is the one this client was sent last
 * (`keptViews.members`): a message in a community changes its `lastMessageAt`, and its 256 members went again with each
 * one, about 37 KB per tab per message.
 *
 * A history's and a change's rows go without their details record (`withoutDetails`).
 */
export function copyingSink(post: (message: PostedEvent) => void): EngineClientSink {
  let sent: Pick<EngineState, "payments" | "wallet"> | null = null;
  let pictures = new Map<string, string>();
  // Per view sent last: the engine's view it was copied from, its marks, and the two as one text.
  let views = new Map<string, { view: object; mark: string; key: string }>();
  // Per group, its member list as this client has it now, as one text.
  let members = new Map<string, string>();
  return {
    post: (message) => {
      if (message.kind === "messages" || message.kind === "message-changes") return post({ ...message, messages: message.messages.map(withoutDetails) });
      if (message.kind !== "state") return post(message);
      const { payments, wallet, settings, links, edges, groups, identityProofs, nostr, ...rest } = message.state;
      const now = new Map<string, string>();
      const kept: KeptPictures = {};
      // Whether this picture is the one sent last under this name (an id is once in its list: the engine's links and
      // groups are kept by id, a community member's pay link is named by group and member).
      const sentBefore = (name: string, picture: string | undefined): boolean => !!picture && pictures.get(name) === picture;
      const same = (name: string, picture: string | undefined): boolean => {
        if (picture) now.set(name, picture);
        return sentBefore(name, picture);
      };
      // Each item's picture that is the one sent last is named in `kept`; the copy without it is made only for an item
      // that goes (`leaveOutSame`): one left out whole is not copied.
      const keepPictures = <T extends { id: string }>(list: T[] | undefined, kind: "links" | "edges" | "groups", field: keyof T & ("peerAvatar" | "picture")): void => {
        for (const item of list ?? []) if (same(`${kind}:${item.id}`, item[field] as string | undefined)) (kept[kind] ??= []).push(item.id);
      };
      const withoutPicture = <T extends { id: string }>(item: T, kind: "links" | "edges" | "groups", field: keyof T & ("peerAvatar" | "picture")): T => {
        if (!sentBefore(`${kind}:${item.id}`, item[field] as string | undefined)) return item;
        const { [field]: _, ...without } = item;
        return without as T;
      };
      // A public profile's picture deeper in an item, named by its list (`name`) and its key there.
      const keepAt = <U>(list: U[], name: string, at: PictureAt<U>, keys: () => string[]): void => {
        for (const item of list) if (same(`${name}\n${at.key(item)}`, at.get(item))) keys().push(at.key(item));
      };
      const withoutAt = <T extends U, U>(list: T[], name: string, at: PictureAt<U>): T[] =>
        list.map((item) => (sentBefore(`${name}\n${at.key(item)}`, at.get(item)) ? at.set(item, undefined) : item));
      const leaveOutAt = <T extends U, U>(list: T[], name: string, at: PictureAt<U>, keys: () => string[]): T[] => {
        keepAt(list, name, at, keys);
        return withoutAt(list, name, at);
      };
      const keepContactProfiles = (link: LinkView): void => {
        if (link.identities?.received) keepAt(link.identities.received, `received\n${link.id}`, identityPicture, () => ((kept.received ??= {})[link.id] ??= []));
        if (link.nostr) keepAt(link.nostr, `nostr\n${link.id}`, nostrPicture, () => ((kept.nostr ??= {})[link.id] ??= []));
      };
      const withoutContactPictures = (link: LinkView): LinkView => {
        const received = kept.received?.[link.id] && link.identities?.received && withoutAt(link.identities.received, `received\n${link.id}`, identityPicture);
        const nostr = kept.nostr?.[link.id] && link.nostr && withoutAt(link.nostr, `nostr\n${link.id}`, nostrPicture);
        if (!received && !nostr) return link;
        return { ...link, ...(received && { identities: { ...link.identities!, received } }), ...(nostr && { nostr }) };
      };
      const ownKept = same("avatar", settings?.avatar);
      if (ownKept) kept.avatar = true;
      const nowViews = new Map<string, { view: object; mark: string; key: string }>();
      const keptViews: KeptViews = {};
      // The views in `list` this client was sent last as they are now, with the same pictures left out (`marks`): those
      // stay out, and `keptViews` lists every id in order. A list with an id twice goes whole. `engine`: the engine's
      // views; one the same object as last time, with the same marks, is the same copy and is not copied (`copy`: the
      // view as it goes, its pictures left out).
      const leaveOutSame = <T extends { id: string }>(engine: T[], kind: "links" | "edges" | "groups", marks: (id: string) => unknown, copy: (view: T) => T): T[] => {
        if (!engine) return engine;
        const copies: T[] = [];
        const copied = (i: number) => (copies[i] ??= copy(engine[i]));
        const left = new Set<string>();
        for (const [i, view] of engine.entries()) {
          const name = `${kind}:${view.id}`;
          if (nowViews.has(name)) return engine.map((_, i) => copied(i));
          const mark = JSON.stringify(marks(view.id)) ?? "", had = views.get(name);
          const key = had?.view === view && had.mark === mark ? had.key : `${mark}\n${JSON.stringify(copied(i))}`;
          nowViews.set(name, { view, mark, key });
          if (had?.key === key) left.add(view.id);
        }
        if (!left.size) return engine.map((_, i) => copied(i));
        keptViews[kind] = engine.map((view) => view.id);
        // The page keeps a view left out whole, its pictures with it.
        if (kept[kind]) kept[kind] = kept[kind].filter((id) => !left.has(id));
        if (kind === "links") for (const id of left) { delete kept.received?.[id]; delete kept.nostr?.[id]; }
        return engine.flatMap((view, i) => (left.has(view.id) ? [] : [copied(i)]));
      };
      const nowMembers = new Map<string, string>();
      // The groups going (`list`) whose member list is the one this client was sent last: they go without it, named in
      // `keptViews.members`. A group left out whole keeps the list it had. A list with an id twice goes as it is.
      const leaveOutMembers = (list: GroupView[]): GroupView[] => {
        if (!list || !groups) return list;
        const going = new Set(list.map((view) => view.id));
        for (const view of groups) if (!going.has(view.id) && members.has(view.id)) nowMembers.set(view.id, members.get(view.id)!);
        if (going.size < list.length) return list;
        return list.map((view) => {
          const text = JSON.stringify(view.members) ?? "";
          nowMembers.set(view.id, text);
          if (members.get(view.id) !== text) return view;
          (keptViews.members ??= []).push(view.id);
          const { members: _, ...without } = view;
          return without as GroupView;
        });
      };
      keepPictures(links, "links", "peerAvatar");
      links?.forEach(keepContactProfiles);
      keepPictures(edges, "edges", "peerAvatar");
      keepPictures(groups, "groups", "picture");
      const keptLinks = new Set(kept.links), keptEdges = new Set(kept.edges), keptGroups = new Set(kept.groups);
      const sentLinks = leaveOutSame(links, "links", (id) => [keptLinks.has(id), kept.received?.[id], kept.nostr?.[id]], (view) => withoutContactPictures(withoutPicture(view, "links", "peerAvatar")));
      const sentEdges = edges && leaveOutSame(edges, "edges", (id) => keptEdges.has(id), (view) => withoutPicture(view, "edges", "peerAvatar"));
      const sentGroups = leaveOutMembers(leaveOutSame(groups, "groups", (id) => keptGroups.has(id), (view) => withoutPicture(view, "groups", "picture")));
      for (const list of ["links", "edges", "groups", "received", "nostr"] as const) {
        const value = kept[list];
        if (Array.isArray(value) ? !value.length : value && !Object.keys(value).length) delete kept[list];
      }
      post({ kind: "state", state: {
        ...rest,
        ...(identityProofs && { identityProofs: leaveOutAt(identityProofs, "identityProofs", identityPicture, () => (kept.identityProofs ??= [])) }),
        ...(nostr && { nostr: { ...nostr, own: leaveOutAt(nostr.own, "nostrOwn", nostrPicture, () => (kept.nostrOwn ??= [])) } }),
        settings: ownKept ? (({ avatar: _, ...without }) => without)(settings) : settings,
        links: sentLinks,
        ...(edges && { edges: sentEdges }),
        groups: sentGroups,
        ...(sent && payments === sent.payments ? {} : { payments }),
        ...(sent && wallet === sent.wallet ? {} : { wallet }),
        ...(Object.keys(kept).length ? { keptPictures: kept } : {}),
        ...(Object.keys(keptViews).length ? { keptViews } : {}),
      } });
      sent = { payments, wallet };
      pictures = now;
      views = nowViews;
      members = nowMembers;
    },
  };
}
