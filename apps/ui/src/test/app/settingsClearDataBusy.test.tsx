import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { clearAllData } from "../../lib/clearData";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import en from "../../locales/en/settings.json";
import ar from "../../locales/ar/settings.json";

// covers: app.clear-data

/*
 * Clear all data waits for the peer to take back what it can (seconds, at worst until it gives up on it) before it
 * clears this device. Its confirm said "All data cleared" at once and put the Clear button back meanwhile: the
 * confirm stays open and busy until the clear is done, says so only then, and a clear that fails says that instead.
 */

vi.mock("../../lib/clearData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clearData")>()),
  clearAllData: vi.fn(),
}));

afterEach(() => {
  vi.mocked(clearAllData).mockReset();
  vi.restoreAllMocks();
  localStorage.clear();
});

const WORDS = { en, ar } as const;

function open(language: keyof typeof WORDS) {
  windowIs(false);
  // The reload that follows a clear: what was on the page when it came is noted.
  const seen: string[] = [];
  const replace = vi.spyOn(window.location, "replace").mockImplementation(() => { seen.push(document.body.textContent ?? ""); });
  const rendered = renderApp(
    <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
    { route: "/settings/storage", language },
  );
  return { ...rendered, replace, seen };
}

/** Clear, then the confirm's Clear all data. */
async function confirmClear(user: ReturnType<typeof open>["user"]) {
  await user.click(screen.getByTestId("clear-all-data"));
  await user.click(screen.getByTestId("clear-all-data-confirm"));
}

for (const language of ["en", "ar"] as const) {
  const words = WORDS[language] as typeof en;
  describe(`Clear all data (${language})`, () => {
    it("stays busy until the clear is done, says so only then, and starts the page over", async () => {
      let finish!: () => void;
      vi.mocked(clearAllData).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
      const { user, replace, seen } = open(language);
      await confirmClear(user);
      expect(clearAllData).toHaveBeenCalledTimes(1);

      // Nothing is gone yet: not said to be, and no Clear button to press again.
      expect(document.body).not.toHaveTextContent(words.dataCleared);
      expect(screen.queryByTestId("clear-all-data")).toBeNull();
      const confirm = screen.getByTestId("clear-all-data-confirm");
      expect(confirm).toHaveAttribute("aria-busy", "true");
      expect(confirm).toHaveAttribute("aria-disabled", "true");
      expect(document.activeElement).toBe(confirm);
      // Said once, in the live region there since the confirm opened.
      const saying = screen.getAllByRole("status").filter((el) => el.textContent?.includes(words.clearingData));
      expect(saying).toEqual([screen.getByTestId("clear-all-data-status")]);
      expect(screen.getAllByText(words.clearingData)).toHaveLength(1);
      // A second press while it runs starts nothing.
      await user.click(confirm);
      expect(clearAllData).toHaveBeenCalledTimes(1);
      expect(replace).not.toHaveBeenCalled();

      await act(async () => finish());
      expect(replace).toHaveBeenCalledTimes(1);
      // No success card while it ran nor before the reload: the page starting over is the answer.
      expect(seen[0]).not.toContain(words.dataCleared);
    });

    it("a clear that fails says so, never says cleared, and can be tried again", async () => {
      vi.mocked(clearAllData).mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce(undefined);
      const { user, replace } = open(language);
      await confirmClear(user);

      const list = screen.getByTestId("clear-all-data-list");
      expect(await within(list).findByRole("alert")).toHaveTextContent(words.clearAllDataFailed);
      expect(document.body).not.toHaveTextContent(words.dataCleared);
      expect(replace).not.toHaveBeenCalled();
      expect(screen.queryByTestId("clear-all-data")).toBeNull();
      const confirm = screen.getByTestId("clear-all-data-confirm");
      expect(confirm).not.toHaveAttribute("aria-busy");
      expect(document.activeElement).toBe(confirm);

      await user.click(confirm);
      expect(clearAllData).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
      expect(within(list).queryByRole("alert")).toBeNull();
    });
  });
}
