import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { ChatConnection } from "../components/ChatConnection";
import { useI18n } from "../contexts/I18nContext";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { linkView } from "./fakeEngine";
import { renderApp } from "./render";
// covers: chat.paired.reconnect, app.i18n

/** The harness itself: the UI reaches the fake engine through the web app's platform modules. */
describe("component test harness", () => {
  function Probe() {
    const platform = useServicesPlatform();
    const { t } = useI18n();
    const [tokens, setTokens] = useState("");
    useEffect(() => { void engine.call("walletExport").then((all) => setTokens(`${all.length} tokens`)).catch((e: Error) => setTokens(e.message)); }, []);
    return <p>{t("sidebar.settings")} · {platform?.getPeer("peer")?.id ?? "no chat"} · {tokens}</p>;
  }

  it("renders with the app's providers, the fake's state, and answers calls a test scripted", async () => {
    const { engine: fake } = renderApp(<Probe />);
    expect(screen.getByText(/no chat/)).toBeInTheDocument();
    fake.on("walletExport", () => []);
    fake.update({ links: [linkView({ id: "chat-7" })] });
    expect(await screen.findByText(/chat-7/)).toBeInTheDocument();
    expect(fake.callsTo("walletExport")).toHaveLength(1);
  });

  it("fails a call nobody answers, instead of hanging", async () => {
    renderApp(<Probe />);
    expect(await screen.findByText(/nothing answers "walletExport"/)).toBeInTheDocument();
  });

  it("speaks the language in the settings", () => {
    renderApp(<Probe />, { language: "pt" });
    expect(screen.getByText(/Ajustes/)).toBeInTheDocument();
  });

  // A link in a message opens in a new tab (target="_blank"), and happy-dom loads that tab's page: a test that clicked
  // a message's github.com link reached GitHub on every run, CI's included.
  it("loads nothing for a link a test follows to a new tab", async () => {
    let asked!: () => void;
    const reached = new Promise<string>((resolve) => { asked = () => resolve("asked"); });
    const server = createServer((_, res) => { asked(); res.end("<p>page</p>"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      render(<a href={`http://127.0.0.1:${port}/page`} target="_blank" rel="noopener noreferrer">page</a>);
      fireEvent.click(screen.getByRole("link", { name: "page" }));
      expect(await Promise.race([reached, new Promise((resolve) => setTimeout(resolve, 500, "nothing asked"))])).toBe("nothing asked");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// The example in apps/ui/src/test/README.md, kept working.
it("reconnects from the connection menu (README example)", async () => {
  const { user, engine } = renderApp(<ChatConnection peerKey="peer" />);
  engine.on("connect", () => undefined).update({ links: [linkView({ pairing: { status: "error", error: "Relay refused" } })] });
  await user.click(screen.getByTestId("connection-options"));
  await user.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(engine.callsTo("connect")).toEqual([{ linkId: "link-1" }]);
});
