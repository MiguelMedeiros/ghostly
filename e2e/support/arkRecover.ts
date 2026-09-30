import { execFileSync } from "node:child_process";
import { expect, type Locator } from "@playwright/test";

/** Blocks on e2e/infra's regtest chain (worthless coins). */
const mine = (blocks: number) => execFileSync(process.execPath, ["e2e/support/ark-regtest/regtest.mjs", "mine", String(blocks)], { encoding: "utf8", stdio: "pipe" });

/**
 * Expired Ark coins back into the balance, as a person would get them back: wait until the server has swept their
 * batch, then press Recover once. Returns the sats it brought back (0: nothing had expired).
 *
 * Coins past their batch's expiry are shown as waiting (`ark-sweeping`, no Recover) until arkd sweeps that batch:
 * a recovery before it fails, and arkd then bans the coins for a while. e2e/infra's arkd counts its expiry in blocks
 * (`ARKD_VTXO_TREE_EXPIRY: 180`, under 512: blocks after the batch confirmed), while a coin reads as expired 180 s
 * after its batch: on this chain the sweep comes after about 180 more blocks, so this mines them. The wallet polls
 * every 10 s. The caller holds the "regtest-chain" lock (e2e/support/exclusive.ts), so no other test mines meanwhile.
 */
export async function recoverExpiredArk(panel: Locator, who: string, balance: () => Promise<number>): Promise<number> {
  const sweeping = panel.getByTestId("ark-sweeping"), recoverable = panel.getByTestId("ark-recoverable");
  let mined = 0;
  while (await sweeping.isVisible()) {
    expect(mined, `${who}'s expired coins were not swept after ${mined} blocks`).toBeLessThan(400);
    mine(40);
    mined += 40;
    await sweeping.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
  }
  if (!(await recoverable.isVisible())) {
    if (mined) console.log(`Ark recovery evidence: ${who}'s batch swept after ${mined} blocks; too few to recover (${await smallExpiredArk(panel)} sats)`);
    return 0;
  }
  const before = await balance();
  // Once: a failed recovery is not retried (a batch that fails for the server's reasons bans the coins for a while).
  // While the batch runs the SDK leaves the coins out of every figure, so the row going away proves nothing: the
  // balance growing does.
  await panel.getByTestId("ark-recover").click();
  await expect.poll(balance, { timeout: 120_000, message: `${who}'s recovered coins are back in the balance` }).toBeGreaterThan(before);
  await expect(recoverable).toHaveCount(0);
  await expect(sweeping).toHaveCount(0);
  const back = (await balance()) - before;
  console.log(`Ark recovery evidence: ${who}'s batch swept after ${mined} blocks; Recover brought ${back} sats back (${before} before)`);
  return back;
}

/**
 * Expired sats swept but too few for a recovery of their own (`ark-small`): still the wallet's, recovered with the
 * next coins that expire. A receiver gets these when a small payment was made from coins about to expire.
 */
export async function smallExpiredArk(panel: Locator): Promise<number> {
  const row = panel.getByTestId("ark-small");
  if (!(await row.isVisible())) return 0;
  return Number(/\d[\d.,\s]*/.exec(await row.innerText())?.[0].replace(/[^\d]/g, "") ?? NaN);
}
