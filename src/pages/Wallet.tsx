import { useDeferredValue, useState } from "react";
import { WalletDeck } from "../components/WalletDeck";
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
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useI18n } from "../contexts/I18nContext";
import { Page, PageAction } from "../components/layout";
import type { WalletPlatform, WalletState } from "../lib/platform";

const CARD_KEY = "ghostly-wallet-card";
/** The card chosen last in this tab: a wallet's id, or (a tab from before wallets had networks) a rail. */
const remembered = (): string => {
  try { return sessionStorage.getItem(CARD_KEY) ?? sessionStorage.getItem("ghostly-wallet-rail") ?? ""; } catch { return ""; }
};

/**
 * The wallets, as a page beside the chat list like Settings: every wallet at the top, as a deck, each with its own
 * network; the chosen one below with what it is for (receive, send) and its few options. New, in the header, makes
 * another; a profile with none says how to start.
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
  const [creating, setCreating] = useState(false);
  // The first setup stays in view until it ends: its second wallet, or its one failure, still has something to say.
  const [firstRun, setFirstRun] = useState(false);
  // The deck paints first and the chosen card's panel follows, in a render React can interrupt for frames: the two
  // together overrun a frame, and opening the wallet (or bringing up another card) would stutter.
  const panel = useDeferredValue<string | null>(selected?.id ?? null, null);
  const select = (next: string) => { setChosen(next); try { sessionStorage.setItem(CARD_KEY, next); } catch { /* storage unavailable */ } };

  return (
    <Page title={t("tabs.wallet")} testId="wallet" trailing={wallet && state && (
      <PageAction label={t("sidebar.new")} title="Create a wallet" testId="wallet-add" onClick={() => setCreating(true)} />
    )}>
      {platform?.notice && <p className="px-3 py-2 rounded-lg bg-yellow-500/10 text-yellow-500 text-xs" data-testid="platform-notice">{platform.notice}</p>}
      {!wallet || !state ? <p className="text-text-muted text-sm">The wallet is not available here.</p> : !cards.length || !selected || firstRun ? (
        <FirstWallet wallet={wallet} onNew={() => setCreating(true)} onStart={() => setFirstRun(true)} onMade={(id) => { setFirstRun(false); select(id); }} />
      ) : <>
        <WalletDeck cards={cards} selected={selected.id} onSelect={select} />
        <div role="tabpanel" id="wallet-panel" aria-labelledby={`wallet-tab-${selected.id}`}>
          {panel && <WalletPanel id={panel} wallet={wallet} state={state} onOpen={select} />}
        </div>
      </>}
      {creating && wallet && state && (
        <NewWalletDialog wallet={wallet} offers={state.offers ?? []} initialNetwork={selected?.network ?? "testnet"}
          onClose={() => setCreating(false)} onCreated={(made) => { setCreating(false); select(made.id); }} />
      )}
    </Page>
  );
}

/** The chosen wallet's panel, on its own network: its calls and its state are that network's. */
function WalletPanel({ id, wallet, state, onOpen }: { id: string; wallet: WalletPlatform; state: WalletState; onOpen: (id: InstanceCard["id"]) => void }) {
  const card = parseCardId(id);
  if (!card) return null;
  const { rail, network } = card;
  const scoped = wallet.forNetwork(network), shown = networkState(state, network);
  switch (rail) {
    case "cashu": case "lightning": return <CashuWallet key={id} wallet={scoped} state={shown} rail={rail} onOpenCashu={() => onOpen(cardId("cashu", network))} />;
    case "arkade": return <ArkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "bark": return <BarkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "spark": return <SparkWalletPanel key={id} wallet={scoped} state={shown} />;
    case "usdt": return <UsdtWalletPanel key={id} wallet={scoped} state={shown} />;
    case "bitcoin": return <BitcoinWalletPanel key={id} wallet={scoped} state={shown} />;
    case "fedimint": return <FedimintWalletPanel key={id} wallet={scoped} state={shown} />;
  }
}
