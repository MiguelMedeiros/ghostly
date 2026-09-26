import { useDeferredValue, useLayoutEffect, useRef, useState } from "react";
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
import { NetworkTag } from "../components/NetworkTag";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { Page, PageAction } from "../components/layout";
import type { WalletNetwork, WalletPlatform, WalletState } from "../lib/platform";

const CARD_KEY = "ghostly-wallet-card";
/** The card chosen last in this tab: a wallet's id, or (a tab from before wallets had networks) a rail. */
const remembered = (): string => {
  try { return sessionStorage.getItem(CARD_KEY) ?? sessionStorage.getItem("ghostly-wallet-rail") ?? ""; } catch { return ""; }
};
/** Real money first, then test money: each network's wallets are a deck of their own, never mixed. */
const NETWORKS: readonly WalletNetwork[] = ["mainnet", "testnet"];

/**
 * The wallets, as a page beside the chat list like Settings: real money and test money apart, each network's wallets
 * a deck of their own; the chosen wallet below with what it is for (receive, send), its few options and Remove. New,
 * in the header (or in a network's empty section), makes another; a profile with none says how to start.
 */
export function Wallet() {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const wallet = platform?.wallet;
  const state = wallet?.getState();
  const cards = state ? walletCards(state) : [];
  const [chosen, setChosen] = useState<string>(remembered);
  // A remembered rail (older tab) picks that rail's first wallet.
  const selected = cards.find((c) => c.id === chosen) ?? cards.find((c) => c.rail === chosen) ?? cards[0];
  // The card each network's deck showed last: the deck that is not the panel's keeps it on top.
  const [tops, setTops] = useState<Partial<Record<WalletNetwork, string>>>({});
  const [creating, setCreating] = useState<WalletNetwork | null>(null);
  // The first setup stays in view until it ends: its second wallet, or its one failure, still has something to say.
  const [firstRun, setFirstRun] = useState(false);
  // A wallet just made: its card is dealt into its deck once it is there.
  const [dealt, setDealt] = useState<string | null>(null);
  const page = useRef<HTMLDivElement>(null);
  // The decks paint first and the chosen card's panel follows, in a render React can interrupt for frames: the two
  // together overrun a frame, and opening the wallet (or bringing up another card) would stutter.
  const panel = useDeferredValue<string | null>(selected?.id ?? null, null);
  // Whether the panel's field (Cashu's amount) takes the focus: when a person chose the wallet (a click, a tap or Enter
  // on its card, a link to it), never as the page opens or as its card comes up under the pointer passing over the
  // deck, a key moving along it or a swipe settling. The field is below the decks: a focus there would move the focus
  // away from where the person is (and in WebKit, the page down to the field).
  const [focusPanel, setFocusPanel] = useState(false);
  const select = (next: string, focus = true) => {
    setChosen(next);
    setFocusPanel(focus);
    const network = parseCardId(next)?.network;
    if (network) setTops((t) => t[network] === next ? t : { ...t, [network]: next });
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
  /** After a removal: the next card of the same network, else any, else the first setup. */
  const removed = (id: string) => {
    const rest = cards.filter((c) => c.id !== id), network = parseCardId(id)?.network;
    const next = rest.find((c) => c.network === network) ?? rest[0];
    if (next) select(next.id, false);
  };

  return (
    <Page title={t("tabs.wallet")} testId="wallet" trailing={wallet && state && (
      <PageAction label={t("sidebar.new")} title="Create a wallet" testId="wallet-add" onClick={() => setCreating(selected?.network ?? "testnet")} />
    )}>
      <div ref={page} className="space-y-6">
        {platform?.notice && <p className="px-3 py-2 rounded-lg bg-yellow-500/10 text-yellow-500 text-xs" data-testid="platform-notice">{platform.notice}</p>}
        {!wallet || !state ? <p className="text-text-muted text-sm">The wallet is not available here.</p> : !cards.length || !selected || firstRun ? (
          <FirstWallet wallet={wallet} onNew={() => setCreating("testnet")} onStart={() => setFirstRun(true)} onMade={(id) => { setFirstRun(false); select(id); setDealt(id); }} />
        ) : <>
          {NETWORKS.map((network) => {
            const mine = cards.filter((c) => c.network === network), live = selected.network === network;
            const top = live ? selected.id : (mine.find((c) => c.id === tops[network]) ?? mine[0])?.id;
            return <NetworkSection key={network} network={network} cards={mine} selected={top} resting={!live} onSelect={(id) => select(id, false)} onChoose={() => setFocusPanel(true)} onNew={() => setCreating(network)} />;
          })}
          <div role="tabpanel" id="wallet-panel" aria-labelledby={`wallet-tab-${selected.id}`} data-testid="wallet-panel" data-network={selected.network} className="space-y-6">
            <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary" data-testid="wallet-panel-title">
              <NetworkTag network={selected.network} testId="wallet-panel-network" />
              <span className="font-medium text-text-primary">{selected.name}</span>
            </p>
            {/* Test coins only when asked for: Receive never fills a Testnet wallet by itself. */}
            {panel && parseCardId(panel)?.network === "testnet" && <TestCoins key={`coins-${panel}`} rail={parseCardId(panel)!.rail} network="testnet" wallet={wallet.forNetwork("testnet")} state={networkState(state, "testnet")} />}
            {panel && <WalletPanel id={panel} wallet={wallet} state={state} focus={focusPanel} onOpen={select} />}
            {panel && parseCardId(panel) && <RemoveWalletSection key={panel} type={parseCardId(panel)!.rail} network={parseCardId(panel)!.network} wallet={wallet} state={state} onOpen={select} onRemoved={() => removed(panel)} />}
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

/**
 * One network's wallets: a heading that says whose money it is in words ("Real money · Mainnet"), the network's deck,
 * or, with none yet, a line saying so and New for that network.
 */
function NetworkSection({ network, cards, selected, resting, onSelect, onChoose, onNew }: {
  network: WalletNetwork;
  cards: InstanceCard[];
  selected: string | undefined;
  resting: boolean;
  onSelect: (id: string) => void;
  onChoose: (id: string) => void;
  onNew: () => void;
}) {
  const name = NETWORK_NAME[network];
  return (
    <section className="space-y-3" data-testid={`wallet-section-${network}`} data-network={network} data-resting={resting || undefined} aria-labelledby={`wallet-section-${network}-title`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <h2 id={`wallet-section-${network}-title`} className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <NetworkTag network={network} testId={`wallet-section-${network}-tag`} />{" "}<span>· {name}</span>
          </h2>
          {cards.length > 0 && <span className="text-xs text-text-muted" data-testid={`wallet-section-${network}-count`}>{cards.length} {cards.length === 1 ? "wallet" : "wallets"}</span>}
        </div>
        <p className="text-xs text-text-muted">{network === "mainnet" ? "Money you own: spend it with care." : "Test coins, worth nothing: for trying things out."}</p>
      </div>
      {cards.length && selected ? <WalletDeck network={network} cards={cards} selected={selected} resting={resting} onSelect={onSelect} onChoose={onChoose} /> : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3" data-testid={`wallet-section-${network}-empty`}>
          <p className="text-sm text-text-secondary">No {name} wallets yet.</p>
          <Button data-testid={`wallet-section-${network}-new`} onClick={onNew}>New {name} wallet</Button>
        </div>
      )}
    </section>
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
