import type { Page } from "@playwright/test";
import { copyInvite, pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";

/**
 * The pairing scene tells each side how far the first connection got: the inviter's invite goes out and waits,
 * the joiner looks it up and knocks, both answer, connect and go live, and then the chat takes over.
 */

const INVITER = ["publishing", "waiting", "answering", "connecting", "live"];
const JOINER = ["resolving", "knocking", "answering", "connecting", "live"];

/** Records every stage the scene shows, however briefly: polling from the test would miss the short ones. */
async function recordStages(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    const state = window as unknown as { qaPairingStages: string[]; qaPairingIndicator: boolean };
    state.qaPairingStages = seen;
    state.qaPairingIndicator = false;
    const look = () => {
      const stage = document.querySelector("[data-testid=pairing-scene]")?.getAttribute("data-stage");
      if (stage && seen[seen.length - 1] !== stage) seen.push(stage);
      if (document.querySelector("[data-testid=pairing-indicator]")) state.qaPairingIndicator = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stage"] });
    look();
  });
}
const recorded = (page: Page) => page.evaluate(() => {
  const state = window as unknown as { qaPairingStages: string[]; qaPairingIndicator: boolean };
  return { stages: state.qaPairingStages, indicator: state.qaPairingIndicator };
});

/** Stages of `steps` only, each later than the one before, ending at live. */
function expectInOrder(stages: string[], steps: string[]) {
  expect(stages.every(stage => steps.includes(stage)), `unexpected stage in ${stages.join(" → ")}`).toBe(true);
  const positions = stages.map(stage => steps.indexOf(stage));
  expect(positions.every((position, i) => i === 0 || position > positions[i - 1]), `out of order: ${stages.join(" → ")}`).toBe(true);
  expect(stages.at(-1)).toBe("live");
}

test("pairing shows its stages in order on both sides, ends live, then gives the chat back", { tag: ["@feature:chat.paired.pairing-progress", "@feature:chat.paired.progress", "@feature:chat.paired.pair"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("progress-alice"), peer("progress-bob")]);
  await Promise.all([recordStages(alice.page), recordStages(bob.page)]);

  await alice.page.getByTitle("New Chat").click();
  const scene = alice.page.getByTestId("pairing-scene");
  await expect(scene).toHaveAttribute("data-stage", "waiting");
  await expect(alice.page.getByTestId("pairing-stage-label")).toHaveText("Waiting for your contact to open the invite");
  await expect(alice.page.getByTestId("pairing-elapsed")).toHaveText(/^\d+:\d\d$/);
  await expect(alice.page.getByTestId("pairing-steps").locator("[aria-current=step]")).toHaveAttribute("data-step", "waiting");
  // The invite is right under the scene, and the header says the same in small.
  await expect(alice.page.getByTestId("invite-card")).toBeVisible();
  await expect(alice.page.getByTestId("pairing-indicator")).toHaveAccessibleName("Pairing: Waiting for your contact to open the invite");

  const invite = await copyInvite(alice.page);
  await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(bob.page, invite);
  await expect(bob.page.getByTestId("pairing-scene")).toBeVisible();

  for (const { page } of [alice, bob]) await expect(page.getByPlaceholder("Message…")).toBeEnabled();
  // The "connected" moment, then the chat is the chat again: no scene, no indicator.
  for (const { page } of [alice, bob]) {
    await expect(page.getByTestId("pairing-scene")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("pairing-indicator")).toHaveCount(0);
  }

  const [inviter, joiner] = await Promise.all([recorded(alice.page), recorded(bob.page)]);
  expectInOrder(inviter.stages, INVITER);
  expectInOrder(joiner.stages, JOINER);
  expect(inviter.stages).toContain("waiting");
  expect(joiner.stages.length, `the joiner saw only ${joiner.stages.join(" → ")}`).toBeGreaterThan(1);
  expect(inviter.indicator && joiner.indicator).toBe(true);
});

test("with reduced motion the scene is a still picture of the stage", { tag: ["@feature:chat.paired.pairing-progress"] }, async ({ peer }) => {
  const alice = await peer("progress-still");
  await alice.page.emulateMedia({ reducedMotion: "reduce" });
  await alice.page.getByTitle("New Chat").click();
  const scene = alice.page.getByTestId("pairing-scene");
  await expect(scene).toHaveAttribute("data-stage", "waiting");
  const motion = await scene.evaluate(root => [...root.querySelectorAll(".ps-float, .ps-pk, .ps-ping, .ps-blink")].map(element => getComputedStyle(element).animationName));
  expect(motion.length).toBeGreaterThan(0);
  expect(new Set(motion)).toEqual(new Set(["none"]));
  // Words and steps say it all without motion.
  await expect(alice.page.getByTestId("pairing-stage-label")).toHaveText("Waiting for your contact to open the invite");
  await expect(alice.page.getByTestId("pairing-announcement")).toHaveText("Waiting for your contact to open the invite");
});
