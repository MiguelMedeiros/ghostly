/**
 * How the catalogue presents the families of WISP drafts: titles, blurbs,
 * icons and order. Nothing here is about one WISP: a draft's summary,
 * availability, notes and feature link are rows of its own header table in
 * docs/wisps, read by `npm run sync:references` (scripts/wisp-header.mjs).
 */
import type { DimId } from "./composition";

export type GroupId =
  | "meet"
  | "connect"
  | "talk"
  | "files"
  | "calls"
  | "pay"
  | "services"
  | "identity"
  | "keep"
  | "together"
  | "headless"
  | "apps";

/**
 * The WISPs page draws the families as a stack, top to bottom: the core first, and each layer builds on the
 * ones above it. This is presentation only; the reader's sidebar keeps the order of GROUPS.
 */
export const LAYERS: { label: string; groups: GroupId[] }[] = [
  { label: "Core", groups: ["meet", "keep"] },
  { label: "Link", groups: ["connect"] },
  { label: "Talk", groups: ["talk", "files", "calls"] },
  { label: "In a chat", groups: ["pay", "services", "identity"] },
  { label: "Many people", groups: ["together"] },
  { label: "Programs", groups: ["headless", "apps"] },
];

export const GROUPS: {
  id: GroupId;
  ranges: [number, number][];
  order?: string[];
  title: string;
  blurb: string;
  icon: string;
  /** Its colour: the row of the same pieces on the roadmap's map (DIMS in lib/composition.ts). */
  dim: DimId;
}[] = [
  {
    id: "meet",
    dim: "base",
    ranges: [[0, 3], [6, 99], [800, 899]],
    order: ["00", "01", "02", "03", "800", "801"],
    icon: "spark",
    title: "Meet",
    blurb: "The small core: rendezvous records, keys, invitations and agreeing on what both sides support.",
  },
  {
    id: "connect",
    dim: "transport",
    ranges: [[100, 199]],
    icon: "route",
    title: "Connect",
    blurb: "Choosing a data path both peers share, and the adapters that provide one.",
  },
  {
    id: "talk",
    dim: "talk",
    ranges: [[400, 499]],
    icon: "chat",
    title: "Chat",
    blurb: "One kind of chat: a live peer-to-peer link when one connects, short text through the DHT when none does, and items held in your own storage for a contact who is away.",
  },
  {
    id: "files",
    dim: "talk",
    ranges: [[500, 599]],
    icon: "file",
    title: "Files",
    blurb: "Bounded, verified file transfer over the live link, or held for a contact who is away.",
  },
  {
    id: "calls",
    dim: "talk",
    ranges: [[600, 699]],
    icon: "video",
    title: "Voice & video",
    blurb: "Real-time media coordinated separately from the data stream.",
  },
  {
    id: "pay",
    dim: "pay",
    ranges: [[200, 299]],
    icon: "bolt",
    title: "Payments",
    blurb: "Negotiate a payment method, carry the request, let a wallet adapter do the rest.",
  },
  {
    id: "services",
    dim: "services",
    ranges: [[700, 799]],
    icon: "window",
    title: "Local services",
    blurb: "Let a contact open something running on your computer, and take it back.",
  },
  {
    id: "identity",
    dim: "identity",
    ranges: [[300, 399]],
    icon: "badge",
    title: "Identity proofs",
    blurb: "Optional proofs that you control an outside identity. Never required to talk.",
  },
  {
    id: "keep",
    dim: "keep",
    ranges: [[4, 5], [1000, 1099]],
    order: ["04", "05", "1000", "1001", "1002"],
    icon: "box",
    title: "Profiles & storage",
    blurb: "Separate lives on one device, sealed backups, and where those backups are kept.",
  },
  {
    id: "together",
    dim: "groups",
    ranges: [[900, 999]],
    order: ["900", "902", "901"],
    icon: "group",
    title: "Groups",
    blurb: "Private groups of up to 32 and communities of up to 256: text, a picture and payments between members.",
  },
  {
    id: "headless",
    dim: "ecosystem",
    ranges: [[1100, 1199]],
    icon: "terminal",
    title: "Headless & bots",
    blurb: "The app's own engine without a screen, driven by other programs on the same machine.",
  },
  {
    id: "apps",
    dim: "ecosystem",
    ranges: [[1200, 1299]],
    icon: "puzzle",
    title: "Apps & plugins",
    blurb: "Apps and games made by others: found in stores you choose or sent in a chat, checked by their publisher's signature, run in a sandbox.",
  },
];
