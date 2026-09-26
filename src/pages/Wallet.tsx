import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { WALLET_NETWORKS as NETWORKS, isWalletNetwork as isNetwork } from "@ghostly/core";
import { NetworkTabs } from "../components/wallet/NetworkTabs";
import { WalletDeck, walletCardTestId } from "../components/WalletDeck";
import { cardId, cardWallet, deckId, networkState, parseCardId, walletCards, type InstanceCard } from "../components/walletCardData";
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
import { focusInPlace } from "../lib/focus";
import { navOnly } from "../lib/navigation";
import { playCue } from "../lib/cues";
import type { WalletInstanceView, WalletNetwork, WalletPlatform, WalletState } from "../lib/platform";

const CARD_KEY = "ghostly-wallet-card";
/** The card chosen last in this tab: a wallet's id, or (a tab from before wallets had networks) a rail. */
const remembered = (): string => {
  try { return sessionStorage.getItem(CARD_KEY) ?? sessionStorage.getItem("ghostly-wallet-rail") ?? ""; } catch { return ""; }
};
/** The network tab shown last on this device: a view of the page, not a mode (payments never read it). */
export const NETWORK_KEY = "ghostly-wallet-network";
const rememberedNetwork = (): WalletNetwork | null => {
  try { const value = localStorage.getItem(NETWORK_KEY); if (isNetwork(value)) return value; } catch { /* storage unavailable */ }
  return parseCardId(remembered())?.network ?? null;
};
/**
 * A wallet whose real money rests on a recovery phrase kept on this device: made with New, it opens on its backup rows
 * (Settings), asking for a copy of the phrase before money goes in. Real money with no copy is one lost device from gone.
 */
const backupFirst = (made: WalletInstanceView) => made.network === "mainnet" && made.type === "bark";
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
  // A Lightning card's id changes as a second one comes or goes (`lightning:testnet` ↔ `lightning:testnet:<card>`): the same card still.
  const same = parseCardId(chosen[network]);
  const selected = shown.find((c) => c.id === chosen[network]) ?? shown.find((c) => c.rail === chosen[network])
    ?? (same && shown.find((c) => c.rail === same.rail && c.network === same.network && (!same.card || !c.card || c.card === same.card))) ?? shown[0];
  // How the last switch went, for the deck's way in (none as the page opens: the deck has no entry motion).
  const [swap, setSwap] = useState<"next" | "prev" | null>(null);
  const [creating, setCreating] = useState<WalletNetwork | null>(null);
  // "Create a … wallet" elsewhere (a chat's money card) comes here with `newWallet`: New opens on that network, once.
  const location = useLocation(), navigate = useNavigate();
  const asked = (location.state as { newWallet?: { network?: unknown } } | null)?.newWallet;
  useEffect(() => {
    if (!asked) return;
    if (isNetwork(asked.network)) setCreating(asked.network);
    void navigate(location.pathname, { replace: true, state: navOnly(location.state) });
  }, [asked, location.pathname, location.state, navigate]);
  // The first setup stays in view until it ends: its second wallet, or its one failure, still has something to say.
  const [firstRun, setFirstRun] = useState(false);
  // A wallet just made: its card is dealt into its deck once it is there, and takes the focus.
  const [dealt, setDealt] = useState<string | null>(null);
  // A wallet just made that asks for its backup first (`backupFirst`): its panel opens on the backup rows, focus there.
  const [backup, setBackup] = useState<string | null>(null);
  const page = useRef<HTMLDivElement>(null);
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
    setBackup((b) => b === next ? b : null);
    show(card.network);
    try { sessionStorage.setItem(CARD_KEY, next); } catch { /* storage unavailable */ }
  };
  const ids = cards.map((c) => c.id).join();
  useLayoutEffect(() => {
    if (!dealt) return;
    const card = page.current?.querySelector<HTMLElement>(`[data-testid="${walletCardTestId(dealt)}"]`);
    const face = card?.querySelector<HTMLElement>("[data-deck=face]");
    if (!card || !face) return;
    dealCard(face);
    playCue("wallet");
    // The focus goes to the new card (New's dialog, closing, leaves it to the page), or to its backup rows.
    if (backup !== dealt) focusInPlace(card);
    setDealt(null);
  }, [dealt, ids, backup]);
  /** New made `made`: the dialog has closed; its card comes to the front of its network's tab, selected. */
  const created = (made: WalletInstanceView) => {
    setCreating(null);
    // Its card in the deck: a network's only Lightning card is its Lightning, one of several its own.
    const wallets = state?.wallets?.some((w) => w.id === made.id) ? state.wallets : [...(state?.wallets ?? []), made];
    const id = state ? deckId(made, { ...state, wallets }) : cardId(made.type, made.network);
    select(id, false);
    setBackup(backupFirst(made) ? id : null);
    setDealt(id);
  };
  /** After a removal: the next card of the same network; with none left the tab stays, saying so. */
  const removed = (id: string) => {
    const next = shown.find((c) => c.id !== id);
    if (next) select(next.id, false);
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
          <NetworkTabs network={network} counts={{ mainnet: cards.filter((c) => c.network === "mainnet").length, testnet: cards.filter((c) => c.network === "testnet").length }}
            onChange={(n) => { setFocusPanel(false); show(n); }} label="Networks" testId="wallet-networks" tabTestId="wallet-network" idPrefix="wallet-network-tab" controls="wallet-network-panel" />
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
              {panel && parseCardId(panel)?.network === "testnet" && <TestCoins key={`coins-${panel}`} rail={parseCardId(panel)!.rail} network="testnet" wallet={cardWallet(wallet, parseCardId(panel)!)} state={networkState(state, "testnet", parseCardId(panel)!.card)} />}
              {panel && <WalletPanel id={panel} wallet={wallet} state={state} focus={focusPanel} backup={backup === panel} onOpen={select} />}
              {panel && parseCardId(panel) && <RemoveWalletSection key={panel} type={parseCardId(panel)!.rail} network={parseCardId(panel)!.network} card={parseCardId(panel)!.card} wallet={wallet} state={state} onOpen={select} onRemoved={() => removed(panel)} />}
            </div>}
          </div>
        </>}
      </div>
      {creating && wallet && state && (
        <NewWalletDialog wallet={wallet} offers={state.offers ?? []} initialNetwork={creating}
          onClose={() => setCreating(null)} onCreated={created} />
      )}
    </Page>
  );
}

/** The chosen wallet's panel, on its own network: its calls and its state are that network's. */
function WalletPanel({ id, wallet, state, focus, backup, onOpen }: { id: string; wallet: WalletPlatform; state: WalletState; focus: boolean; backup: boolean; onOpen: (id: InstanceCard["id"]) => void }) {
  const card = parseCardId(id);
  if (!card) return null;
  const { rail, network } = card;
  const scoped = cardWallet(wallet, card), shown = networkState(state, network, card.card);
  switch (rail) {
    case "cashu": case "lightning": return <CashuWallet key={id} wallet={scoped} state={shown} rail={rail} onOpenCashu={() => onOpen(cardId("cashu", network))} focusAmount={focus} />;
    case "arkade": return <ArkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "bark": return <BarkWalletPanel key={id} wallet={scoped} state={shown} backupNow={backup} />;
    case "spark": return <SparkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "usdt": return <UsdtWalletPanel key={id} wallet={scoped} state={shown} />;
    case "bitcoin": return <BitcoinWalletPanel key={id} wallet={scoped} state={shown} />;
    case "fedimint": return <FedimintWalletPanel key={id} wallet={scoped} state={shown} />;
  }
}
