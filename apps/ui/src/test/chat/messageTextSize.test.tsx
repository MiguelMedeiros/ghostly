import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { InvoiceBubble } from "../../components/InvoiceBubble";
import { Unshowable } from "../../components/MessageBoundary";
import { PaymentBubble } from "../../components/PaymentBubble";
import { ButtonPress } from "../../components/chat/MessageButtons";
import { findMoney } from "../../lib/money";
import { renderApp } from "../render";

// covers: settings.text-size

/*
 * Settings → Text size scales a message's words through `chat-text-message`. A few messages drew their own words at
 * the Default size written out (14.2px), so at Huge they stayed two thirds the size of the messages around them: the
 * words around an invoice, a payment's line, a button press's reply, a message that failed to draw.
 */
describe("a message's own words follow Text size", () => {
  it("the words around an invoice", () => {
    renderApp(<InvoiceBubble money={findMoney(`Here you go: ${fakeInvoice(1_000, new Uint8Array(32).fill(7), "coffee")}`)!} mine={false} />);
    expect(screen.getByText("Here you go:")).toHaveClass("chat-text-message");
  });

  it("a payment's line before its record is read", () => {
    renderApp(<PaymentBubble paymentId="gone" peerPubKey="peer" fallbackText="Paid 1000 sats" mine />);
    expect(screen.getByText(/1000|1,000/).closest("span")).toHaveClass("chat-text-message");
  });

  it("a button press's reply, with and without the question to go to", () => {
    const { unmount } = renderApp(<ButtonPress label="Yes" />);
    expect(screen.getByTestId("button-press")).toHaveClass("chat-text-message");
    unmount();
    renderApp(<ButtonPress label="Yes" targetId="question-1" />);
    expect(screen.getByTestId("button-press")).toHaveClass("chat-text-message");
  });

  it("a message that failed to draw", () => {
    renderApp(<Unshowable text="hello" fromMe={false} />);
    expect(screen.getByText("hello").parentElement).toHaveClass("chat-text-message");
  });

  it("no component writes the message's size out instead of using the class", () => {
    const components = join(fileURLToPath(import.meta.url), "../../../components");
    const fixed = readdirSync(components, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"))
      .filter((file) => readFileSync(join(components, file), "utf8").includes("text-[14.2px]"));
    expect(fixed).toEqual([]);
  });
});
