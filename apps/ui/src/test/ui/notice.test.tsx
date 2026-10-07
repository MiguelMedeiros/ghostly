import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Notice } from "../../components/ui/Notice";
import { renderApp } from "../render";

// covers: app.i18n

describe("Notice: a few words, the rest behind the ⓘ", () => {
  it("shows the title and the next step, and the English only once asked for, with a way to copy it", async () => {
    const { user } = renderApp(<Notice testId="n" problem={{ tone: "error", title: "Can't reach the relays", next: "Check your connection", detail: "Error: https://pkarr.example.test responded 500" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Can't reach the relays" + "Check your connection");
    expect(screen.queryByText(/pkarr/)).toBeNull();
    await user.click(screen.getByTestId("n-info"));
    expect(screen.getByTestId("n-details")).toHaveTextContent("Error: https://pkarr.example.test responded 500");
    expect(screen.getByTestId("n-copy")).toHaveTextContent("Copy");
  });

  it("is no alert while the app retries by itself, and has no ⓘ with nothing more to say", () => {
    renderApp(<Notice testId="n" problem={{ tone: "wait", title: "Waiting for the relays", next: "Retrying in 52 s" }} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("n")).toHaveAttribute("data-tone", "wait");
    expect(screen.queryByTestId("n-info")).toBeNull();
  });

  it("keeps the wallet's plain notices: children are the title", () => {
    renderApp(<Notice tone="error" testId="w">Not enough sats</Notice>);
    expect(screen.getByRole("alert")).toHaveTextContent("Not enough sats");
  });
});
