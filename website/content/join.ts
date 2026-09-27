import type { InviteRefusal } from "@/lib/invite";

/** The join page: what a visit to ghostly.tools/#ghostly1… shows over the page. */
export const join = {
  title: "You're invited to a chat",
  lead: "Someone sent you a Ghostly invite. Open it where you use Ghostly.",
  browser: "Open in your browser",
  desktop: "Open in the desktop app",
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
  } satisfies Record<InviteRefusal, string>,
};

export type JoinCopy = typeof join;
