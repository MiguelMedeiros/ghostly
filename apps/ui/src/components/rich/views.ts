import type { ComponentType } from "react";
import type { Atom } from "../../lib/parse";
import { BlobView, LinkView, MdLinkView, TimeView } from "./AtomViews";
import { MentionChip } from "../MentionChip";

export interface AtomViewProps<A extends Atom = Atom> {
  atom: A;
  /** When the message was sent (ms). */
  sentAt?: number;
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
