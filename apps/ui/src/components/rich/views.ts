import type { ComponentType } from "react";
import type { Atom } from "../../lib/parse";
import { BlobView, LinkView, MdLinkView, TimeView } from "./AtomViews";
import { MentionChip } from "../MentionChip";

export interface AtomViewProps<A extends Atom = Atom> {
  atom: A;
  /** When the message was sent (ms). */
  sentAt?: number;
  /** A chat search's words and matches in the run of text the atom sits in, and where the atom's words start in it. */
  marks?: AtomMarks;
}

export interface AtomMarks {
  term: string;
  ranges: readonly [number, number][];
  start: number;
  /** The first of the matches an atom finds in its own words that the message may still mark (RichText's `SEARCH_MARK_BUDGET`). */
  spend: (ranges: [number, number][]) => [number, number][];
}

/** A view for one kind of atom; typed loosely here, since each view knows its own atom's data. */
export type AtomView = ComponentType<AtomViewProps<never>>;

/**
 * How each kind of atom looks, by the detector's `kind` (apps/ui/src/lib/parse/detectors.ts). A kind with no view here shows
 * as the text it matched, so a new detector works before it has a look of its own.
 */
export const VIEWS: Record<string, AtomView> = {
  link: LinkView,
  "md-link": MdLinkView,
  blob: BlobView,
  time: TimeView,
  "member-mention": MentionChip,
};

/** Kinds whose view isolates its own parts, so the rich text does not wrap it in one `<bdi>`: a mention's "@" follows the message's direction, only its name is isolated. */
export const ISOLATES_ITSELF: ReadonlySet<string> = new Set(["member-mention"]);
