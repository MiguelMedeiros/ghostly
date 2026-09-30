/**
 * Sats came in while the wallet was closed: a dot on the wallet icon, like the other places' marks. Filled for real
 * sats, hollow for test sats only. How many is in the place's tooltip and name, never on the bar. It pops again
 * when more arrive. `backup`: a Mainnet wallet's backup reminder asks (see useBackupDue): the same filled dot while
 * nothing new shows, one dot on the icon at most.
 */
export function UnseenSatsDot({ unseen, tab, backup }: { unseen: { real: number; test: number }; tab?: boolean; backup?: boolean }) {
  if (!unseen.real && !unseen.test) return backup ? <span data-testid="wallet-backup-due" aria-hidden="true" className={`nav-dot${tab ? " nav-dot-tab" : ""}`} /> : null;
  return (
    <span data-testid="wallet-new" aria-hidden="true" key={unseen.real + unseen.test}
      className={`nav-dot${tab ? " nav-dot-tab" : ""}${unseen.real ? "" : " nav-dot-test"}`} />
  );
}
