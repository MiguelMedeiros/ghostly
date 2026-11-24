import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { sameValue } from "../../lib/sameValue";
import type { ChipLink } from "./IdentityActivity";

/*
 * What the identity readers that list every chat read of the engine's state: whose each chat is and the identities
 * that contact shared (a contact's identities beside the chat names the people its activity's chips show by it, the
 * Identities page lists what every contact shared, the chat list shows each contact as the identity chosen for them).
 *
 * The engine sends its whole state anew on every change (up to 20 a second while a file moves), with a new `links`
 * list that holds every chat it did not change as the same view. Built anew on each state, these lists cost an entry
 * per chat and a walk of them all to find them unchanged (about 1 ms a state at 2,000 chats). So each chat's entry is
 * built once per view, a list once per `links` list and shared by every reader of that state, and a list whose entries
 * are all the last list's is the last list itself: a reader then finds it unchanged at once.
 */

const NONE: readonly ChipLink[] = Object.freeze([]);

/** Each chat view's entry (a view the engine sends again is the same object). */
const chipOfView = new WeakMap<LinkView, ChipLink>();
/** Each `links` list's entries, so every reader of one state shares them. */
const chipsOfList = new WeakMap<readonly LinkView[], readonly ChipLink[]>();
/** The last list read, with its entries by position: a later list holds mostly the same views at the same places. */
let held: { views: readonly LinkView[]; chips: readonly ChipLink[] } = { views: [], chips: NONE };

/**
 * A chat view's entry. A new view with the same content as the entry at its place (the chat changed, not whose it is
 * or what they shared) keeps that entry, so what shows it is not drawn again.
 */
function chipOf(view: LinkView, there: ChipLink | undefined): ChipLink {
  let chip = chipOfView.get(view);
  if (chip) return chip;
  chip = { id: view.id, peerPubKeyZ32: view.peerPubKeyZ32, identities: view.identities && { received: view.identities.received } };
  if (there && sameValue(chip, there)) chip = there;
  chipOfView.set(view, chip);
  return chip;
}

/** Every chat's entry, in the state's order: the same list as long as no chat's entry changed. */
export function chipLinks(views: readonly LinkView[] | undefined): readonly ChipLink[] {
  if (!views?.length) return NONE;
  const known = chipsOfList.get(views);
  if (known) return known;
  const { views: lastViews, chips: lastChips } = held;
  // Allocated only from the first entry that differs from the last list's.
  let chips: ChipLink[] | undefined;
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    const chip = view === lastViews[i] ? lastChips[i] : chipOf(view, lastChips[i]);
    if (!chips && (chip !== lastChips[i] || views.length !== lastChips.length)) chips = lastChips.slice(0, i);
    chips?.push(chip);
  }
  const out = chips ?? lastChips;
  held = { views, chips: out };
  chipsOfList.set(views, out);
  return out;
}

const sharingOfList = new WeakMap<readonly ChipLink[], readonly ChipLink[]>();

/** The chats whose contact shared an identity: the same list as long as no chat's entry changed. */
export function sharingLinks(views: readonly LinkView[] | undefined): readonly ChipLink[] {
  const chips = chipLinks(views);
  let out = sharingOfList.get(chips);
  if (!out) sharingOfList.set(chips, out = chips.filter((c) => c.identities?.received.length));
  return out;
}

type Keyed = readonly [peerKey: string, received: ReceivedIdentityView[]];
const keyedOfChip = new WeakMap<ChipLink, Keyed>();
const keyedOfList = new WeakMap<readonly ChipLink[], readonly Keyed[]>();

/**
 * Each contact's received identities, by key, of every chat that holds them (a paired chat does, even with none): all a
 * list of contacts reads to show their faces. The same list as long as no chat's entry changed.
 */
export function receivedByKey(views: readonly LinkView[] | undefined): readonly Keyed[] {
  const chips = chipLinks(views);
  let out = keyedOfList.get(chips);
  if (!out) {
    out = chips.flatMap((c) => {
      if (!c.identities?.received) return [];
      let keyed = keyedOfChip.get(c);
      if (!keyed) keyedOfChip.set(c, keyed = [c.peerPubKeyZ32, c.identities.received]);
      return [keyed];
    });
    keyedOfList.set(chips, out);
  }
  return out;
}
