import { screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { PairingBanner } from "../components/PairingBanner";
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
    expect(screen.getByText(/Configurações/)).toBeInTheDocument();
  });
});

// The example in src/test/README.md, kept working.
it("reconnects from the connection menu (README example)", async () => {
  const { user, engine } = renderApp(<PairingBanner peerKey="peer" />);
  engine.on("connect", () => undefined).update({ links: [linkView({ pairing: { status: "error", error: "Relay refused" } })] });
  await user.click(screen.getByTestId("connection-options"));
  await user.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(engine.callsTo("connect")).toEqual([{ linkId: "link-1" }]);
});
