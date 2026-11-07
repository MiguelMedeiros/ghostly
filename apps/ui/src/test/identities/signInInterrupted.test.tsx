import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heedInterruptedSignIn } from "../../desktop/android";
import { signInInterrupted, takeSignInInterrupted } from "../../lib/signInInterrupted";
import { Identities } from "../../pages/Identities";
import { renderApp } from "../render";

// covers: proofs.oidc.callback.android

/*
 * An identity sign-in on Android whose process Android ended while the provider's page was in the browser: the answer
 * starts a new process that never asked for it (apps/desktop/src/oidc.rs `not_taken`). The page hears of it and the
 * Identities page says the sign-in was interrupted, with Try again, instead of the start screen saying nothing.
 */

afterEach(() => {
  takeSignInInterrupted();
  location.hash = "";
});

describe("a sign-in Android interrupted", () => {
  it("is asked for at start, as the answer may have started the app, and opens Identities once", async () => {
    const answers = [true, false];
    const invoke = vi.fn(async (command: string) => {
      if (command === "oidc_interrupted") return answers.shift() ?? false;
      throw new Error(command);
    });
    let heard: () => void = () => {};
    const listen = vi.fn(async (_event: string, handler: () => void) => { heard = handler; });
    heedInterruptedSignIn(invoke as never, listen);
    await vi.waitFor(() => expect(location.hash).toBe("#/identities"));
    expect(listen).toHaveBeenCalledWith("oidc-interrupted", expect.any(Function));
    expect(takeSignInInterrupted()).toBe(true);
    expect(takeSignInInterrupted()).toBe(false);

    // Rust says so while the page runs (the answer came once it listened): asked again, and taken there.
    location.hash = "#/";
    heard();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await new Promise((done) => setTimeout(done, 10));
    expect(location.hash).toBe("#/");
    expect(takeSignInInterrupted()).toBe(false);
  });

  it("says nothing when no sign-in was interrupted, or in an app without the command", async () => {
    heedInterruptedSignIn((async () => false) as never, async () => {});
    heedInterruptedSignIn((async () => { throw new Error("unknown command"); }) as never, async () => { throw new Error("no events"); });
    await new Promise((done) => setTimeout(done, 10));
    expect(location.hash).toBe("");
    expect(takeSignInInterrupted()).toBe(false);
  });

  it("is said on the Identities page, once, and Try again starts adding one", async () => {
    signInInterrupted();
    const first = renderApp(<Identities />, { route: "/identities" });
    const notice = screen.getByTestId("sign-in-interrupted");
    expect(within(notice).getByRole("alert")).toHaveTextContent("The sign-in was interrupted");
    await first.user.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
    expect(screen.queryByTestId("sign-in-interrupted")).not.toBeInTheDocument();
    first.unmount();

    // Said once: the page opened again does not say it again.
    renderApp(<Identities />, { route: "/identities" });
    expect(screen.queryByTestId("sign-in-interrupted")).not.toBeInTheDocument();
    // Heard while the page is open.
    act(() => signInInterrupted());
    expect(screen.getByTestId("sign-in-interrupted")).toHaveTextContent("The sign-in was interrupted");
  });

  it("is said in the app's language", () => {
    signInInterrupted();
    renderApp(<Identities />, { route: "/identities", language: "pt" });
    const notice = screen.getByTestId("sign-in-interrupted");
    expect(notice).toHaveTextContent("O login foi interrompido");
    expect(within(notice).getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});
