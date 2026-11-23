import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readStatusCard } from "@ghostly/core";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import type { ProfileOpenFailure } from "@ghostly/browser/shared/idb";
import { ClockOffHint } from "../../components/ClockOffHint";
import { DirectBlockedHint } from "../../components/DirectBlockedHint";
import { ProfileUnavailable } from "../../components/ProfileUnavailable";
import { TasksButton } from "../../components/chat/TasksButton";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { UpdateProvider } from "../../contexts/UpdateContext";
import type { WalletState } from "../../lib/platform";
import { servicesPlatform } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: app.accessibility

/**
 * Each ⓘ takes a tap in 44 px on a phone, as `InfoButton` (layout/Section.tsx) does: the connection panel's notes, an
 * unavailable profile's line and the wallet's set-aside and unconfirmed lines had hand-made copies of it that grew only
 * to 40 px, and the Tasks panel's ⓘ was a 32 px box that did not grow at all.
 */
const PHONE_44 = "max-md:before:-inset-3";

describe("an ⓘ on a phone", () => {
  it("the connection panel's notes: a tap lands in 44 px", () => {
    renderApp(<><ClockOffHint ms={5 * 60_000} /><DirectBlockedHint /></>);
    expect(screen.getByTestId("connection-clock-off-info")).toHaveClass("before:absolute", PHONE_44);
    expect(screen.getByTestId("connection-direct-blocked-info")).toHaveClass("before:absolute", PHONE_44);
  });

  it("an unavailable profile's line: a tap lands in 44 px", () => {
    const newer: ProfileOpenFailure = { reason: "newer", supportedVersion: 11, storedVersion: 12 };
    renderApp(<UpdateProvider><ProfileUnavailable failure={newer} /></UpdateProvider>);
    expect(screen.getByTestId("profile-unavailable-info")).toHaveClass("before:absolute", PHONE_44);
  });

  it("the wallet's set-aside and unconfirmed lines: a tap lands in 44 px, and each names the text it opens", async () => {
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINTS[0], 5_000)], balance: 5_000, setAside: 6, unconfirmed: 3 }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    for (const line of ["wallet-set-aside", "wallet-unconfirmed"]) {
      const info = screen.getByTestId(`${line}-info`);
      expect(info, line).toHaveClass("before:absolute", PHONE_44);
      // The two lines sit one under the other: 20 px tall, their ⓘ areas would overlap by 20 px and the lower ⓘ would
      // take the band. Each line holds its own ⓘ's 44 px.
      expect(screen.getByTestId(line), line).toHaveClass("max-md:min-h-[44px]");
      await user.click(info);
      expect(screen.getByTestId(`${line}-text`), line).toHaveAttribute("id", info.getAttribute("aria-controls"));
    }
  });

  it("the Tasks panel's: a tap lands in 44 px, clear of the × beside it", async () => {
    const card = readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running" })!;
    const { user } = renderApp(<TasksButton rows={[{ id: "m1", sender: "peer", timestamp: 1, card }]} />);
    await user.click(screen.getByTestId("chat-tasks"));
    const info = screen.getByTestId("chat-tasks-info");
    expect(info).toHaveClass("tap-target");
    // 32 px boxes 4 px apart: grown to 44 px, the ⓘ's area would take 6 px of the ×'s. 12 px apart on a phone, it ends
    // 6 px before the ×, the room the × needs to grow to 44 px.
    expect(info.parentElement).toHaveClass("gap-1");
    expect(info).toHaveClass("max-md:me-2");
  });
});
