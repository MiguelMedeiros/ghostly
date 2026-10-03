import type { Page } from "@playwright/test";
import { copyInvite, pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";

/**
 * The pairing scene tells each side how far the first connection got: the inviter's invite goes out and waits,
 * the joiner looks it up and knocks, both answer, connect and go live, and then the chat takes over.
 */

const INVITER = ["publishing", "waiting", "answering", "connecting", "live"];
const JOINER = ["resolving", "knocking", "answering", "connecting", "live"];
/** STUN is answered in the test process: each offer and answer waits for it, up to 5 s when Google's servers are slow. */
const PAIRING = { localStun: true };

/** Records every stage the scene shows, however briefly: polling from the test would miss the short ones. */
async function recordStages(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [], steps: number[] = [];
    const state = window as unknown as { qaPairingStages: string[]; qaPairingSteps: number[]; qaPairingIndicator: boolean };
    state.qaPairingStages = seen;
    state.qaPairingSteps = steps;
    state.qaPairingIndicator = false;
    const look = () => {
      const scene = document.querySelector("[data-testid=pairing-scene]");
      const stage = scene?.getAttribute("data-stage"), step = scene?.getAttribute("data-step");
      if (stage && seen[seen.length - 1] !== stage) seen.push(stage);
      if (step != null && steps[steps.length - 1] !== Number(step)) steps.push(Number(step));
      // The connection icon told the pairing: its stage, and the scene in small while it was on its way.
      if (document.querySelector("[data-testid=connection-options][data-pairing] [data-testid=pairing-glyph]")) state.qaPairingIndicator = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stage", "data-step", "data-pairing"] });
    look();
  });
}
const recorded = (page: Page) => page.evaluate(() => {
  const state = window as unknown as { qaPairingStages: string[]; qaPairingSteps: number[]; qaPairingIndicator: boolean };
  return { stages: state.qaPairingStages, steps: state.qaPairingSteps, indicator: state.qaPairingIndicator };
});

/**
 * Each step later than the one before, ending at live. Either side can be at either side's handshake stage (an
 * inviter whose contact does not knock knocks itself), so the stages are checked through the step they show.
 */
function expectInOrder({ stages, steps }: { stages: string[]; steps: number[] }, names: string[]) {
  expect(steps.every((step, i) => i === 0 || step > steps[i - 1]), `out of order: ${stages.join(" → ")} (steps ${steps.join(", ")})`).toBe(true);
  expect(stages.at(-1)).toBe("live");
  expect(steps.at(-1)).toBe(names.indexOf("live"));
}

test("pairing shows its stages in order on both sides, ends live, then gives the chat back", { tag: ["@feature:chat.paired.pairing-progress", "@feature:chat.paired.progress", "@feature:chat.paired.pair"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all(["progress-alice", "progress-bob"].map(name => peer(name, PAIRING)));
  await Promise.all([recordStages(alice.page), recordStages(bob.page)]);

  await alice.page.getByTitle("New Chat").click();
  const scene = alice.page.getByTestId("pairing-scene");
  await expect(scene).toHaveAttribute("data-stage", "waiting");
  await expect(alice.page.getByTestId("pairing-stage-label")).toHaveText("Waiting for your contact to open the invite");
  await expect(alice.page.getByTestId("pairing-elapsed")).toHaveText(/^\d+:\d\d$/);
  await expect(alice.page.getByTestId("pairing-steps").locator("[aria-current=step]")).toHaveAttribute("data-step", "waiting");
  // The invite is right under the scene. The header says the same in small, in its only connection element: the
  // connection icon. Under the name there is only the contact's key, with no pill and no status dot.
  await expect(alice.page.getByTestId("invite-card")).toBeVisible();
  const icon = alice.page.getByTestId("connection-options");
  await expect(icon).toHaveAccessibleName("Connection options: Pairing · Waiting for your contact to open the invite");
  await expect(icon).toHaveAttribute("data-pairing", "waiting");
  await expect(alice.page.getByTestId("chat-subtitle")).toHaveText(/^\S+\.\.\.\S+$/);
  await expect(alice.page.getByTestId("chat-subtitle").locator("svg, [role=img], button")).toHaveCount(0);
  await expect(alice.page.getByTestId("contact-status")).toHaveCount(0);
  // Its panel says the step and brings the scene back into view.
  await icon.click();
  await expect(alice.page.getByTestId("connection-pairing-step")).toHaveText("Step 2 of 5");
  await alice.page.getByTestId("connection-show-pairing").click();
  await expect(alice.page.getByTestId("connection-menu")).not.toHaveAttribute("open");
  await expect(scene).toBeInViewport();

  const invite = await copyInvite(alice.page);
  await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(bob.page, invite);
  await expect(bob.page.getByTestId("pairing-scene")).toBeVisible();

  for (const { page } of [alice, bob]) await expect(page.getByPlaceholder("Message…")).toBeEnabled();
  // The "connected" moment, then the chat is the chat again: no scene, and the icon is the transport's.
  for (const { page } of [alice, bob]) {
    await expect(page.getByTestId("pairing-scene")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("connection-options")).not.toHaveAttribute("data-pairing");
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/^Connection options: Connected · /);
  }

  const [inviter, joiner] = await Promise.all([recorded(alice.page), recorded(bob.page)]);
  expectInOrder(inviter, INVITER);
  expectInOrder(joiner, JOINER);
  expect(inviter.stages).toContain("waiting");
  expect(joiner.stages.length, `the joiner saw only ${joiner.stages.join(" → ")}`).toBeGreaterThan(1);
  expect(inviter.indicator && joiner.indicator).toBe(true);
});

test("the inviter's invite card leaves once the joiner knocks, and the scene alone goes on to live", { tag: ["@feature:chat.paired.pairing-progress", "@feature:chat.paired.pair"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all(["invite-leaves-alice", "invite-leaves-bob"].map(name => peer(name, PAIRING)));
  await alice.page.getByTitle("New Chat").click();
  const scene = alice.page.getByTestId("pairing-scene");
  await expect(scene).toHaveAttribute("data-stage", "waiting");
  await expect(alice.page.getByTestId("invite-card")).toBeVisible();
  // The scene's stage at the moment the card starts to leave: the handshake can be too quick to poll for.
  await alice.page.evaluate(() => {
    const state = window as unknown as { qaInviteLeftAt?: string | null };
    const look = () => {
      if (state.qaInviteLeftAt !== undefined) return;
      if (document.querySelector("[data-testid=invite-card]:not([data-leaving])")) return;
      state.qaInviteLeftAt = document.querySelector("[data-testid=pairing-scene]")?.getAttribute("data-stage") ?? null;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-leaving", "data-stage"] });
  });

  const invite = await copyInvite(alice.page);
  await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(bob.page, invite);

  await expect(alice.page.getByTestId("invite-card")).toHaveCount(0);
  // It left while the scene was still on, before the chat took over: the contact had arrived, not the chat gone live.
  const leftAt = await alice.page.evaluate(() => (window as unknown as { qaInviteLeftAt?: string | null }).qaInviteLeftAt);
  // An inviter whose contact does not knock knocks itself, so its scene can be at knocking too.
  expect([...INVITER, "knocking"], `the card left at ${leftAt}`).toContain(leftAt);
  expect(leftAt).not.toBe("publishing");
  // Live, the scene gives the chat back, and the card does not come back with it.
  await expect(alice.page.getByPlaceholder("Message…")).toBeEnabled();
  await expect(scene).toHaveCount(0, { timeout: 10_000 });
  await expect(alice.page.getByTestId("invite-card")).toHaveCount(0);
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

/** Every sound the page starts (its length, and when), and when the scene first shows its live stage. */
async function recordSounds(page: Page) {
  await page.evaluate(() => {
    const state = { heard: [] as { duration: number; at: number }[], liveAt: null as number | null };
    (window as unknown as { qaSounds: typeof state }).qaSounds = state;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: Parameters<typeof start>) {
      state.heard.push({ duration: this.buffer?.duration ?? 0, at: performance.now() });
      return start.apply(this, args);
    };
    new MutationObserver(() => {
      if (state.liveAt === null && document.querySelector("[data-testid=pairing-scene][data-stage=live]")) state.liveAt = performance.now();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-stage"] });
  });
}
const sounds = (page: Page) => page.evaluate(() => (window as unknown as { qaSounds: { heard: { duration: number; at: number }[]; liveAt: number | null } }).qaSounds);

test("the connected moment is heard once on each side, together with the scene going live, and not while waiting", { tag: ["@feature:chat.paired.pairing-progress", "@feature:app.attention.sounds"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all(["sound-alice", "sound-bob"].map(name => peer(name, PAIRING)));
  await Promise.all([recordSounds(alice.page), recordSounds(bob.page)]);
  // The clicks below are the gestures that let each page play sound at all.
  await alice.page.getByTitle("New Chat").click();
  await expect(alice.page.getByTestId("pairing-scene")).toHaveAttribute("data-stage", "waiting");
  const invite = await copyInvite(alice.page);
  await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(bob.page, invite);
  for (const { page } of [alice, bob]) await expect(page.getByTestId("pairing-scene")).toHaveCount(0, { timeout: 15_000 });
  for (const { page } of [alice, bob]) {
    const { heard, liveAt } = await sounds(page);
    // The inviter first hears the contact arrive with the invite (knock.mp3, 0.48 s, the connection cue of #310),
    // before the live scene; the joiner has nothing to be told before it.
    const knocks = page === alice.page ? 1 : 0;
    expect(heard, JSON.stringify(heard)).toHaveLength(knocks + 1);
    const [connected] = heard.slice(-1);
    if (knocks) {
      expect(heard[0].duration).toBeLessThan(0.5);
      expect(heard[0].at).toBeLessThan(liveAt!);
    }
    // connected.mp3 (0.88 s), decoded and played: the synthesized fallback has no buffer.
    expect(connected.duration).toBeGreaterThan(0.8);
    expect(connected.duration).toBeLessThan(1);
    // Asked for in the same change that starts the connected moment: within a few frames of the live scene.
    expect(liveAt).not.toBeNull();
    expect(Math.abs(connected.at - liveAt!)).toBeLessThan(100);
  }
});

test("a chat muted before its contact joins goes live in silence; the contact, not muted, hears it", { tag: ["@feature:chat.paired.pairing-progress", "@feature:app.attention.sounds", "@feature:chats.mute"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all(["sound-muted-alice", "sound-muted-bob"].map(name => peer(name, PAIRING)));
  await Promise.all([recordSounds(alice.page), recordSounds(bob.page)]);
  await alice.page.getByTitle("New Chat").click();
  await expect(alice.page.getByTestId("pairing-scene")).toHaveAttribute("data-stage", "waiting");
  await alice.page.getByTestId("chat-options").click();
  await alice.page.getByTestId("chat-mute-open").click();
  await alice.page.getByTestId("mute-forever").click();
  await expect(alice.page.getByTestId("sidebar").getByTestId("chat-row-muted")).toBeVisible();
  const invite = await copyInvite(alice.page);
  await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(bob.page, invite);
  for (const { page } of [alice, bob]) await expect(page.getByTestId("pairing-scene")).toHaveCount(0, { timeout: 15_000 });
  const [muted, heard] = await Promise.all([sounds(alice.page), sounds(bob.page)]);
  // The moment still shows on the muted side; only its sound is left out.
  expect(muted.liveAt).not.toBeNull();
  expect(muted.heard).toEqual([]);
  expect(heard.heard).toHaveLength(1);
});
