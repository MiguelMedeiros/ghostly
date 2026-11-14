import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { engine } from "@ghostly/browser/platform/engine";
import { MessageBubble } from "../../components/MessageBubble";
import { clearAllData } from "../../lib/clearData";
import { deleteProfile } from "../../lib/profileData";
import { createProfile, namespaceOf, setRunningProfile } from "../../lib/profiles";
import { setStorageProfile } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: payments.cashu.token-card, app.clear-data, profiles.delete

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

/**
 * Redeemed and Paid are what this profile did with the money (WISP 04): another profile on the device neither reads
 * them nor clears them, and Clear all data and Delete profile take this profile's with its other data.
 */

const message = (id: string, text: string) => ({ id, text, sender: "peer", timestamp: Date.now(), status: "delivered" }) as never;
const digest = (text: string) => Buffer.from(sha256(new TextEncoder().encode(text))).toString("hex");
const inDefault = `cashuBa${"d".repeat(60)}`;
const inWork = `cashuBa${"w".repeat(60)}`;

/** This page as profile `id` (the default profile: ""). */
function runAs(id: string) {
  setRunningProfile(id || undefined);
  setStorageProfile(namespaceOf(id));
}

function mint() {
  fakeEngine.setState({ links: [linkView()] });
  fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
}

async function redeem(token: string) {
  mint();
  const view = renderApp(<MessageBubble message={message("m1", token)} peerPubKey="peer" />);
  view.engine.on("walletReceiveToken", () => ({ amount: 1008 }));
  await view.user.click(within(await screen.findByTestId("cashu-token-bubble")).getByTestId("token-redeem"));
  expect(await screen.findByTestId("token-redeemed")).toBeInTheDocument();
  view.unmount();
}

/** Whether the card of `token` says Redeemed in the profile this page runs as. */
async function shownRedeemed(token: string): Promise<boolean> {
  mint();
  const view = renderApp(<MessageBubble message={message("m2", token)} peerPubKey="peer" />);
  const card = await screen.findByTestId("cashu-token-bubble");
  const redeemed = !!within(card).queryByTestId("token-redeemed");
  view.unmount();
  return redeemed;
}

/** Clear all data of the profile this page runs as, the peer's part answered at once. */
async function clear() {
  const call = vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
  await clearAllData();
  call.mockRestore();
}

/** Every value this device stores. */
const stored = () => Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? "").join("\n");

afterEach(() => {
  runAs("");
  vi.restoreAllMocks();
});

describe("the Redeemed mark of a token, with two profiles on the device", () => {
  it("is not read by another profile", async () => {
    const work = createProfile("Work").id;
    await redeem(inDefault);
    runAs(work);
    expect(await shownRedeemed(inDefault)).toBe(false);
    await redeem(inWork);
    runAs("");
    expect(await shownRedeemed(inWork)).toBe(false);
    expect(await shownRedeemed(inDefault)).toBe(true);
  });

  it("goes with another profile's Clear all data, and the default profile's stay", async () => {
    const work = createProfile("Work").id;
    await redeem(inDefault);
    runAs(work);
    await redeem(inWork);
    await clear();
    expect(await shownRedeemed(inWork)).toBe(false);
    expect(stored()).not.toContain(digest(inWork));
    runAs("");
    expect(await shownRedeemed(inDefault)).toBe(true);
  });

  it("goes with the default profile's Clear all data, and another profile's stay", async () => {
    const work = createProfile("Work").id;
    runAs(work);
    await redeem(inWork);
    runAs("");
    await redeem(inDefault);
    await clear();
    expect(await shownRedeemed(inDefault)).toBe(false);
    expect(stored()).not.toContain(digest(inDefault));
    runAs(work);
    expect(await shownRedeemed(inWork)).toBe(true);
  });

  it("of an older version, kept for every profile in one list, is not read by any and goes", async () => {
    const work = createProfile("Work").id;
    localStorage.setItem("ghostly_settled_money", JSON.stringify([digest(inDefault), digest(inWork)]));
    expect(await shownRedeemed(inDefault)).toBe(false);
    runAs(work);
    expect(await shownRedeemed(inWork)).toBe(false);
    expect(localStorage.getItem("ghostly_settled_money")).toBeNull();
  });

  it("goes with its profile when the profile is deleted", async () => {
    const work = createProfile("Work").id;
    runAs(work);
    await redeem(inWork);
    runAs("");
    await redeem(inDefault);
    await deleteProfile(work);
    expect(stored()).not.toContain(digest(inWork));
    expect(await shownRedeemed(inDefault)).toBe(true);
  });
});
