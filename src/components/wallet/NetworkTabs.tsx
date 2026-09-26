import { useRef, type KeyboardEvent } from "react";
import { WALLET_NETWORKS as NETWORKS } from "@ghostly/core";
import "./wallet-networks.css";
import { MONEY_LABEL, NetworkTag } from "../NetworkTag";
import { NETWORK_NAME } from "./names";
import type { WalletNetwork } from "../../lib/platform";

/**
 * Mainnet | Testnet as two tabs, real money first, each saying whose money it is in words (the NetworkTag) and its
 * count: the Wallets page's and the chat payment sheet's, so both look the same. A tablist: the arrows (and Home, End)
 * move and choose as they go. `testId` names the tablist; each tab is `<tabTestId>-<network>`, with `-tag` and `-count` inside.
 * `compact` is the sheet's lower row.
 */
export function NetworkTabs({ network, counts, onChange, label, testId, tabTestId, idPrefix, controls, compact }: {
  network: WalletNetwork;
  counts: Record<WalletNetwork, number>;
  onChange: (network: WalletNetwork) => void;
  label: string;
  testId: string;
  tabTestId: string;
  /** The tabs' element ids are `<idPrefix>-<network>`, for the panel's `aria-labelledby`. */
  idPrefix: string;
  /** The panel's element id. */
  controls: string;
  compact?: boolean;
}) {
  const tabs = useRef<Partial<Record<WalletNetwork, HTMLButtonElement | null>>>({});
  // Two tabs, so either arrow is the other one.
  const keys = (e: KeyboardEvent) => {
    const at = NETWORKS.indexOf(network);
    const to = e.key === "ArrowRight" ? (at + 1) % NETWORKS.length : e.key === "ArrowLeft" ? (at - 1 + NETWORKS.length) % NETWORKS.length
      : e.key === "Home" ? 0 : e.key === "End" ? NETWORKS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(NETWORKS[to]);
    tabs.current[NETWORKS[to]]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="wallet-networks" data-size={compact ? "compact" : undefined} data-testid={testId} onKeyDown={keys}>
      {NETWORKS.map((n) => {
        const count = counts[n], on = n === network;
        return (
          <button key={n} ref={(el) => { tabs.current[n] = el; }} type="button" role="tab" id={`${idPrefix}-${n}`} data-testid={`${tabTestId}-${n}`} data-network={n}
            aria-label={`${MONEY_LABEL[n]}, ${NETWORK_NAME[n]}, ${count} ${count === 1 ? "wallet" : "wallets"}`} aria-selected={on} aria-controls={controls} tabIndex={on ? 0 : -1} className="wallet-network" onClick={() => onChange(n)}>
            <NetworkTag network={n} testId={`${tabTestId}-${n}-tag`} />
            <span className="wallet-network-name">{NETWORK_NAME[n]} <span aria-hidden="true">·</span> <span data-testid={`${tabTestId}-${n}-count`}>{count}</span></span>
          </button>
        );
      })}
    </div>
  );
}
