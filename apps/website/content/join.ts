import type { InviteRefusal } from "@/lib/invite";

/** The join page: what a visit to ghostly.tools/#ghostly1… shows over the page. */
export const join = {
  title: "You're invited to a chat",
  lead: "Someone sent you a Ghostly invite. Open it where you use Ghostly.",
  /** While the page counts down to the web app (JoinLanding.tsx GO_SECONDS). */
  going: (seconds: number) => `Opening the chat in ${seconds}`,
  goingSaid: (seconds: number) => `Opening the chat in your browser in ${seconds} seconds.`,
  goNow: "Open now",
  cancel: "Cancel",
  browser: "Open in your browser",
  desktop: "Open in the Ghostly app",
  desktopCopied: "Invite copied. In Ghostly, choose Join, then Paste.",
  desktopCopyFailed: "Could not copy. Copy this invite, then choose Join in Ghostly:",
  download: "Download Ghostly",
  private: "The invite stays in this browser. It was never sent to ghostly.tools.",
  close: "Close",
  refusedTitle: "This invite can't be opened",
  refused: {
    typo: "This code has a typo. Check it, or ask for the code again.",
    update: "This invite was made by a newer Ghostly. Update to join.",
    "not-ghostly": "This is not a Ghostly invite.",
    damaged: "This invite is damaged. Ask for a new one.",
    device: "This code adds a device to a profile. On the new device, open Ghostly and choose Add this device to another profile.",
  } satisfies Record<InviteRefusal, string>,
  /** A code that adds a device to a profile (WISP 06): no chat, but the web app takes it. */
  device: {
    title: "Add this device to your profile",
    lead: "This code adds a device to a profile. It works once, for 10 minutes.",
    open: "Open in Ghostly",
    steps: "Or open Ghostly on this device, choose Add this device to another profile, and scan or paste the code.",
    private: "The code stays in this browser. It was never sent to ghostly.tools.",
  },
};

export type JoinCopy = typeof join;
