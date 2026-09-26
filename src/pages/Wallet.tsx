import { useDeferredValue, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import "../components/wallet/wallet-networks.css";
import { WalletDeck, walletCardTestId } from "../components/WalletDeck";
import { cardId, networkState, parseCardId, walletCards, type InstanceCard } from "../components/walletCardData";
import { CashuWallet } from "../components/wallet/CashuWallet";
import { ArkWalletPanel } from "../components/ArkWalletPanel";
import { BarkWalletPanel } from "../components/BarkWalletPanel";
import { FedimintWalletPanel } from "../components/FedimintWalletPanel";
import { SparkWalletPanel } from "../components/SparkWalletPanel";
import { UsdtWalletPanel } from "../components/UsdtWalletPanel";
import { BitcoinWalletPanel } from "../components/BitcoinWalletPanel";
import { NewWalletDialog } from "../components/wallet/NewWalletDialog";
import { FirstWallet } from "../components/wallet/FirstWallet";
import { RemoveWalletSection } from "../components/wallet/RemoveWallet";
import { TestCoins } from "../components/wallet/TestCoins";
import { NETWORK_NAME } from "../components/wallet/names";
import { dealCard } from "../components/wallet/motion";
import { Button } from "../components/wallet/ui";
import { MONEY_LABEL, NetworkTag } from "../components/NetworkTag";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { Page, PageAction } from "../components/layout";
import type { WalletNetwork, WalletPlatform, WalletState } from "../lib/platform";

const CARD_KEY = "ghostly-wallet-card";
/** The card chosen last in this tab: a wallet's id, or (a tab from before wallets had networks) a rail. */
const remembered = (): string => {
  try { return sessionStorage.getItem(CARD_KEY) ?? sessionStorage.getItem("ghostly-wallet-rail") ?? ""; } catch { return ""; }
};
/** The network tab shown last on this device: a view of the page, not a mode (payments never read it). */
export const NETWORK_KEY = "ghostly-wallet-network";
const isNetwork = (value: unknown): value is WalletNetwork => value === "mainnet" || value === "testnet";
const rememberedNetwork = (): WalletNetwork | null => {
  try { const value = localStorage.getItem(NETWORK_KEY); if (isNetwork(value)) return value; } catch { /* storage unavailable */ }
  return parseCardId(remembered())?.network ?? null;
};
/** Real money first, then test money: each network's wallets are a deck of their own, never mixed. */
const NETWORKS: readonly WalletNetwork[] = ["mainnet", "testnet"];
const ABOUT: Record<WalletNetwork, string> = { mainnet: "Money you own: spend it with care.", testnet: "Test coins, worth nothing: for trying things out." };

/**
 * The wallets, as a page beside the chat list like Settings: real money and test money as two wallets apart, one tab
 * each (Mainnet | Testnet), and under the tab its network's deck; the chosen wallet below with what it is for
 * (receive, send), its few options and Remove. New, in the header (or in an empty tab), makes another on the tab's
 * network; a profile with none says how to start. The tab only chooses what is shown: every card pays on its own
 * network whichever tab is open.
 */
export function Wallet() {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const wallet = platform?.wallet;
  const state = wallet?.getState();
  const cards = state ? walletCards(state) : [];
  // The tab chosen on this visit; before that, the one shown last on this device while it has wallets (another
  // profile may have none there), else real money when there is some, else test money.
  const [tab, setTab] = useState<WalletNetwork | null>(null);
  const [stored] = useState(rememberedNetwork);
  const has = (n: WalletNetwork) => cards.some((c) => c.network === n);
  const network: WalletNetwork = tab ?? (stored && has(stored) ? stored : has("mainnet") ? "mainnet" : "testnet");
  const shown = cards.filter((c) => c.network === network);
  // The card each tab showed last (a remembered rail, from an older tab, picks that rail's first wallet).
  const [chosen, setChosen] = useState<Record<WalletNetwork, string>>(() => { const r = remembered(); return { mainnet: r, testnet: r }; });
  const selected = shown.find((c) => c.id === chosen[network]) ?? shown.find((c) => c.rail === chosen[network]) ?? shown[0];
  // How the last switch went, for the deck's way in (none as the page opens: the deck has no entry motion).
  const [swap, setSwap] = useState<"next" | "prev" | null>(null);
  const [creating, setCreating] = useState<WalletNetwork | null>(null);
  // The first setup stays in view until it ends: its second wallet, or its one failure, still has something to say.
  const [firstRun, setFirstRun] = useState(false);
  // A wallet just made: its card is dealt into its deck once it is there.
  const [dealt, setDealt] = useState<string | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const tabs = useRef<Partial<Record<WalletNetwork, HTMLButtonElement | null>>>({});
  // The deck paints first and the chosen card's panel follows, in a render React can interrupt for frames: the two
  // together overrun a frame, and opening the wallet (or bringing up another card) would stutter.
  const panel = useDeferredValue<string | null>(selected?.id ?? null, null);
  // Whether the panel's field (Cashu's amount) takes the focus: when a person chose the wallet (a click, a tap or Enter
  // on its card, a link to it), never as the page opens or as its card comes up under the pointer passing over the
  // deck, a key moving along it or a swipe settling. The field is below the deck: a focus there would move the focus
  // away from where the person is (and in WebKit, the page down to the field).
  const [focusPanel, setFocusPanel] = useState(false);
  const show = (next: WalletNetwork) => {
    if (next !== network) setSwap(NETWORKS.indexOf(next) > NETWORKS.indexOf(network) ? "next" : "prev");
    setTab(next);
    try { localStorage.setItem(NETWORK_KEY, next); } catch { /* storage unavailable */ }
  };
  const select = (next: string, focus = true) => {
    const card = parseCardId(next);
    if (!card) return;
    setChosen((c) => c[card.network] === next ? c : { ...c, [card.network]: next });
    setFocusPanel(focus);
    show(card.network);
    try { sessionStorage.setItem(CARD_KEY, next); } catch { /* storage unavailable */ }
  };
  const ids = cards.map((c) => c.id).join();
  useLayoutEffect(() => {
    if (!dealt) return;
    const face = page.current?.querySelector<HTMLElement>(`[data-testid="${walletCardTestId(dealt)}"] [data-deck=face]`);
    if (!face) return;
    dealCard(face);
    setDealt(null);
  }, [dealt, ids]);
  /** After a removal: the next card of the same network; with none left the tab stays, saying so. */
  const removed = (id: string) => {
    const next = shown.find((c) => c.id !== id);
    if (next) select(next.id, false);
  };
  // A tablist moves with the arrows (and Home, End), choosing as it goes: two tabs, so either arrow is the other one.
  const tabKeys = (e: KeyboardEvent) => {
    const at = NETWORKS.indexOf(network);
    const to = e.key === "ArrowRight" ? (at + 1) % NETWORKS.length : e.key === "ArrowLeft" ? (at - 1 + NETWORKS.length) % NETWORKS.length
      : e.key === "Home" ? 0 : e.key === "End" ? NETWORKS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setFocusPanel(false);
    show(NETWORKS[to]);
    tabs.current[NETWORKS[to]]?.focus();
  };

  return (
    <Page title={t("tabs.wallet")} testId="wallet" trailing={wallet && state && (
      <PageAction label={t("sidebar.new")} title="Create a wallet" testId="wallet-add" onClick={() => setCreating(cards.length && !firstRun ? network : "testnet")} />
    )}>
      <div ref={page} className="space-y-6">
        {platform?.notice && <p className="px-3 py-2 rounded-lg bg-yellow-500/10 text-yellow-500 text-xs" data-testid="platform-notice">{platform.notice}</p>}
        {!wallet || !state ? <p className="text-text-muted text-sm">The wallet is not available here.</p> : !cards.length || firstRun ? (
          <FirstWallet wallet={wallet} onNew={() => setCreating("testnet")} onStart={() => setFirstRun(true)} onMade={(id) => { setFirstRun(false); select(id); setDealt(id); }} />
        ) : <>
          <div role="tablist" aria-label="Networks" className="wallet-networks" data-testid="wallet-networks" onKeyDown={tabKeys}>
            {NETWORKS.map((n) => {
              const count = cards.filter((c) => c.network === n).length, on = n === network;
              return (
                <button key={n} ref={(el) => { tabs.current[n] = el; }} type="button" role="tab" id={`wallet-network-tab-${n}`} data-testid={`wallet-network-${n}`} data-network={n}
                  aria-label={`${MONEY_LABEL[n]}, ${NETWORK_NAME[n]}, ${count} ${count === 1 ? "wallet" : "wallets"}`} aria-selected={on} aria-controls="wallet-network-panel" tabIndex={on ? 0 : -1} className="wallet-network" onClick={() => { setFocusPanel(false); show(n); }}>
                  <NetworkTag network={n} testId={`wallet-network-${n}-tag`} />
                  <span className="wallet-network-name">{NETWORK_NAME[n]} <span aria-hidden="true">·</span> <span data-testid={`wallet-network-${n}-count`}>{count}</span></span>
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id="wallet-network-panel" aria-labelledby={`wallet-network-tab-${network}`} data-testid="wallet-network-panel" data-network={network} className="space-y-6">
            <div key={network} className="wallet-network-view space-y-3" data-swap={swap ?? undefined} onAnimationEnd={(e) => { if (e.target === e.currentTarget) setSwap(null); }}>
              <p className="text-xs text-text-muted" data-testid="wallet-network-about">{ABOUT[network]}</p>
              {selected ? <WalletDeck network={network} cards={shown} selected={selected.id} onSelect={(id) => select(id, false)} onChoose={() => setFocusPanel(true)} /> : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3" data-testid={`wallet-network-${network}-empty`}>
                  <p className="text-sm text-text-secondary">No {NETWORK_NAME[network]} wallets yet.</p>
                  <Button data-testid={`wallet-network-${network}-new`} onClick={() => setCreating(network)}>New {NETWORK_NAME[network]} wallet</Button>
                </div>
              )}
            </div>
            {selected && <div role="tabpanel" id="wallet-panel" aria-labelledby={`wallet-tab-${selected.id}`} data-testid="wallet-panel" data-network={selected.network} className="space-y-6">
              <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary" data-testid="wallet-panel-title">
                <NetworkTag network={selected.network} testId="wallet-panel-network" />
                <span className="font-medium text-text-primary">{selected.name}</span>
              </p>
              {/* Test coins only when asked for: Receive never fills a Testnet wallet by itself. */}
              {panel && parseCardId(panel)?.network === "testnet" && <TestCoins key={`coins-${panel}`} rail={parseCardId(panel)!.rail} network="testnet" wallet={wallet.forNetwork("testnet")} state={networkState(state, "testnet")} />}
              {panel && <WalletPanel id={panel} wallet={wallet} state={state} focus={focusPanel} onOpen={select} />}
              {panel && parseCardId(panel) && <RemoveWalletSection key={panel} type={parseCardId(panel)!.rail} network={parseCardId(panel)!.network} wallet={wallet} state={state} onOpen={select} onRemoved={() => removed(panel)} />}
            </div>}
          </div>
        </>}
      </div>
      {creating && wallet && state && (
        <NewWalletDialog wallet={wallet} offers={state.offers ?? []} initialNetwork={creating}
          onClose={() => setCreating(null)} onCreated={(made) => { setCreating(null); select(made.id); setDealt(made.id); }} />
      )}
    </Page>
  );
}

/** The chosen wallet's panel, on its own network: its calls and its state are that network's. */
function WalletPanel({ id, wallet, state, focus, onOpen }: { id: string; wallet: WalletPlatform; state: WalletState; focus: boolean; onOpen: (id: InstanceCard["id"]) => void }) {
  const card = parseCardId(id);
  if (!card) return null;
  const { rail, network } = card;
  const scoped = wallet.forNetwork(network), shown = networkState(state, network);
  switch (rail) {
    case "cashu": case "lightning": return <CashuWallet key={id} wallet={scoped} state={shown} rail={rail} onOpenCashu={() => onOpen(cardId("cashu", network))} focusAmount={focus} />;
    case "arkade": return <ArkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "bark": return <BarkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "spark": return <SparkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "usdt": return <UsdtWalletPanel key={id} wallet={scoped} state={shown} />;
    case "bitcoin": return <BitcoinWalletPanel key={id} wallet={scoped} state={shown} />;
    case "fedimint": return <FedimintWalletPanel key={id} wallet={scoped} state={shown} />;
  }
}
