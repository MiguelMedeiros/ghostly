import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// covers: app.i18n

/**
 * A language is a file of its own, fetched when it is chosen: one that does not arrive (the network dropped, a deploy
 * replaced the files) is said on the Language row, and asked for again.
 */

/** Settings on Appearance, in a fresh copy of the app whose Portuguese fails to load `failures` times. */
async function appWhosePortugueseFails(failures: number) {
  // A fresh copy of the modules: the test setup loads every language into the shared one.
  vi.resetModules();
  const real = await vi.importActual<{ default: Record<string, unknown> }>("../../locales/pt/index.ts");
  let left = failures;
  vi.doMock("../../locales/pt/index.ts", () => {
    if (left-- > 0) throw new Error("Failed to fetch dynamically imported module");
    return real;
  });
  const [{ renderApp }, { Settings }, { LockScreenProvider }, { UpdateProvider }, { installFakeEngine }] = await Promise.all([
    import("../render"), import("../../pages/Settings"), import("../../contexts/LockScreenContext"), import("../../contexts/UpdateContext"),
    import("../fakeEngine"),
  ]);
  installFakeEngine();
  return renderApp(
    <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
    { route: "/settings/appearance" },
  );
}

const choosePortuguese = async (user: Awaited<ReturnType<typeof appWhosePortugueseFails>>["user"]) => {
  await user.click(screen.getByTestId("settings-language"));
  await user.click(await screen.findByRole("option", { name: /Português/ }));
};

afterEach(() => {
  vi.doUnmock("../../locales/pt/index.ts");
  vi.restoreAllMocks();
});

describe("a language whose file does not load", () => {
  it("is said on the Language row, and Try again shows it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { user } = await appWhosePortugueseFails(1);
    await choosePortuguese(user);
    // Said in the language still on screen.
    const notice = await screen.findByTestId("settings-language-not-loaded");
    expect(notice).toHaveTextContent("Português could not be loaded");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Aparência" })).toBeInTheDocument();
    expect(screen.queryByTestId("settings-language-not-loaded")).not.toBeInTheDocument();
  });

  it("is asked for again when the network is back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { user } = await appWhosePortugueseFails(1);
    await choosePortuguese(user);
    await screen.findByTestId("settings-language-not-loaded");

    act(() => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("heading", { name: "Aparência" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("settings-language-not-loaded")).not.toBeInTheDocument());
  });

  it("is asked for again when the window is shown again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { user } = await appWhosePortugueseFails(1);
    await choosePortuguese(user);
    await screen.findByTestId("settings-language-not-loaded");

    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByRole("heading", { name: "Aparência" })).toBeInTheDocument();
  });

  it("says nothing when the language loads", async () => {
    const { user } = await appWhosePortugueseFails(0);
    await choosePortuguese(user);
    expect(await screen.findByRole("heading", { name: "Aparência" })).toBeInTheDocument();
    expect(screen.queryByTestId("settings-language-not-loaded")).not.toBeInTheDocument();
  });
});
