import { useState } from "react";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { InputGroup } from "../layout";
import { useRun } from "./run";
import { Block, Button, Notice, Row, Section, Switch, input } from "./ui";

/**
 * One Lightning card of several on its network: whether it is the default for receiving (chat requests and Receive
 * use it unless another card is picked), and its name. A network's only card is its Lightning: nothing to set here.
 */
export function LightningCardSettings({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
  const ln = state.lightning;
  const { busy, error, run } = useRun();
  const [name, setName] = useState(ln?.name ?? "");
  if (!ln?.card || (state.lightnings?.length ?? 0) < 2) return null;
  const receive = !!ln.receive, changed = name.trim() !== "" && name.trim() !== ln.name;
  return (
    <Section title="Card" testId="lightning-card">
      <Row label="Default for receiving" hint="Requests and Receive use it.">
        <Switch checked={receive} disabled={busy || receive} label="Default for receiving" testId="lightning-card-default" onChange={() => void run(() => wallet.lightningSetReceive())} />
      </Row>
      <Block>
        <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(() => wallet.lightningRename(name)); }}>
          <input aria-label="Card name" data-testid="lightning-card-name" className={input} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" data-testid="lightning-card-rename" disabled={busy || !changed}>Rename</Button>
        </InputGroup>
        {error && <Notice tone="error" testId="lightning-card-error">{error}</Notice>}
      </Block>
    </Section>
  );
}
