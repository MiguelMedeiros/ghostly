/**
 * Sats came in while the wallet was closed: a dot on the wallet icon, like the other places' marks. Filled for real
 * sats, hollow for test sats only. How many is in the place's tooltip and name, never on the bar. It pops again
 * when more arrive.
 */
export function UnseenSatsDot({ unseen, tab }: { unseen: { real: number; test: number }; tab?: boolean }) {
  if (!unseen.real && !unseen.test) return null;
  return (
    <span data-testid="wallet-new" aria-hidden="true" key={unseen.real + unseen.test}
      className={`nav-dot${tab ? " nav-dot-tab" : ""}${unseen.real ? "" : " nav-dot-test"}`} />
  );
}
