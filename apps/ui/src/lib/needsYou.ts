/**
 * Something that needs the person, behind a dot on a place (a tab, a sidebar place). The dot is the first step of a
 * trail: the place's page lists what it is in one line (NeedsYouList), and every step on the way to it (a network
 * tab, a card, a row) wears the same dot, down to the thing itself. A place never wears a dot its page does not lead
 * from.
 *
 * `clears`: "seen" goes once it was looked at where it is (new sats, once their network was shown and the page left);
 * "done" stays until it is done, however often it is looked at (a backup to make). Both are this device's.
 */
export interface NeedsYou {
  /** Stable while it lasts: `sats:testnet`, `backup:cashu:mainnet`, `profiles:new`. */
  id: string;
  /** What it is, in one line: "21 new test sats in Cashu", "Back up your Cashu wallet". */
  text: string;
  clears: "seen" | "done";
  /** Goes to it on its page: brings it up, into view, and gives it the focus where it has something to do. */
  show: () => void;
}
