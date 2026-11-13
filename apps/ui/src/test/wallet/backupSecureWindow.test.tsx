import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { BackupRows } from "../../components/wallet/BackupRows";
import { useRun } from "../../components/wallet/run";
import { lockSecuresWindow } from "../../lib/secureWindow";
import { renderApp } from "../render";

// covers: wallet.ark.backup, wallet.bark.backup, wallet.usdt.backup

function Rows() {
  const { busy, running, run } = useRun();
  return <BackupRows name="Ark" busy={busy} running={running} run={run} reveal={async () => "abandon ability able"} exportBackup={async () => ""} />;
}

describe("a wallet's recovery phrase on screen keeps the window secure (Android)", () => {
  let hide: ReturnType<typeof vi.fn<(on: boolean) => Promise<void>>>;
  beforeEach(() => {
    hide = vi.fn(async (_on: boolean) => {});
    setBrowserHost({ hideFromSwitcher: hide } as Partial<BrowserHost> as BrowserHost);
  });
  afterEach(() => lockSecuresWindow(false));

  it("with the app lock off: secure while the phrase shows, not once it is hidden or the rows go", async () => {
    lockSecuresWindow(false);
    const { user, unmount } = renderApp(<Rows />);
    expect(hide).not.toHaveBeenCalledWith(true);
    await user.click(screen.getByTestId("ark-recovery-show"));
    await waitFor(() => expect(screen.getByTestId("ark-recovery")).toBeInTheDocument());
    expect(hide).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByTestId("ark-recovery-show"));
    expect(screen.queryByTestId("ark-recovery")).not.toBeInTheDocument();
    expect(hide).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByTestId("ark-recovery-show"));
    await waitFor(() => expect(hide).toHaveBeenLastCalledWith(true));
    unmount();
    expect(hide).toHaveBeenLastCalledWith(false);
  });

  it("with the app lock on: hiding the phrase leaves the window secure", async () => {
    lockSecuresWindow(true);
    const { user } = renderApp(<Rows />);
    await user.click(screen.getByTestId("ark-recovery-show"));
    await waitFor(() => expect(screen.getByTestId("ark-recovery")).toBeInTheDocument());
    await user.click(screen.getByTestId("ark-recovery-show"));
    expect(screen.queryByTestId("ark-recovery")).not.toBeInTheDocument();
    expect(hide).toHaveBeenLastCalledWith(true);
    expect(hide).not.toHaveBeenCalledWith(false);
  });
});
