import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { irohRelayProblem } from "@ghostly/browser/platform/irohWeb";
import { NetworkSettings } from "../../components/NetworkSettings";
import { renderApp } from "../render";
import { fakeEngine } from "../fakeEngine";
import { LANGUAGES, lookup } from "../i18n/locales";
import arNetwork from "../../locales/ar/network.json";

// covers: settings.network.native-dht, settings.network.relays, settings.network.iroh-relays, settings.network.turn

const RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];

/** A row's longer explanation: behind its ⓘ, shown once asked for. */
async function info(user: { click: (el: Element) => Promise<void> }, row: HTMLElement): Promise<HTMLElement> {
  await user.click(within(row).getByTestId("row-info"));
  return within(row).getByTestId("row-info-text");
}

describe("Settings, Network: Pkarr relays", () => {
  it("on the Desktop, relay reads are off until switched on, at once, with the relays as saved", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true }, settings: { relays: RELAYS } }));
    const toggle = screen.getByTestId("network-read-relays");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("network-read-relays-row")).toHaveTextContent("Relays see which keys it looks up");
    expect(await info(user, screen.getByTestId("network-read-relays-row"))).toHaveTextContent("reads the Mainline DHT directly");
    // An unsaved edit of the list does not go with the switch.
    await user.type(screen.getByTestId("network-relays"), "\nhttps://unsaved.example");
    await user.click(toggle);
    // The switch leaves the TURN server as it is: one restored without its credential does not stop it.
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toEqual({ settings: { relays: RELAYS, readRelays: true } });
    act(() => engine.update({ settings: { relays: RELAYS, readRelays: true } }));
    expect(screen.getByTestId("network-read-relays")).toHaveAttribute("aria-checked", "true");
    expect(await info(user, screen.getByTestId("network-relays-field"))).toHaveTextContent(/this app writes to them too/);
  });

  it("on the Desktop with Hide my IP on, relay reads show on and stay so: nothing goes to the DHT directly", async () => {
    const { engine } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true }, settings: { relays: RELAYS, relayOnly: true } }));
    const toggle = screen.getByTestId("network-read-relays");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId("network-read-relays-row")).toHaveTextContent("Hide my IP is on: this app reads and writes through these relays only");
    act(() => engine.update({ settings: { relays: RELAYS } }));
    expect(screen.getByTestId("network-read-relays")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("network-read-relays")).toBeEnabled();
  });

  it("in a browser there is no switch: the relays are the only way to the DHT", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS }, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-read-relays")).toBeNull();
    expect(await info(user, screen.getByTestId("network-relays-field"))).toHaveTextContent(/Browsers cannot reach the Mainline DHT/);
  });

  // The engine keeps the relays it can read and drops the rest unsaid: next to working ones, a typo looked saved.
  it("names a line that is not a relay next to working ones, in the app's language, and saves nothing", async () => {
    const { engine, user } = renderApp(<NetworkSettings />, { language: "pt" });
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS }, settings: { relays: RELAYS } }));
    // As the engine takes it: at least one line is a relay.
    engine.on("updateSettings", () => undefined);
    const field = screen.getByTestId("network-relays");
    await user.clear(field);
    await user.type(field, `${RELAYS.join("\n")}\nwss://relay.example.org`);
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error").textContent).toBe("Use https:// no endereço do relay: wss://relay.example.org");
    // Said under the relay list, which is marked refused and gets the focus.
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAttribute("aria-describedby", "network-relays-error");
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, `${RELAYS.join("\n")}\nnot a url`);
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error").textContent).toBe("Não é um endereço de relay: not a url");
    expect(screen.queryByTestId("network-saved")).toBeNull();
    expect(engine.callsTo("updateSettings")).toEqual([]);
    // Fixed, it saves.
    await user.clear(field);
    await user.type(field, `${RELAYS.join("\n")}\nhttps://relay.example.org`);
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { relays: [...RELAYS, "https://relay.example.org"] } });
    expect(screen.getByTestId("network-saved")).toBeInTheDocument();
  });
});

describe("Settings, Network: the transport line", () => {
  const transports = {
    relays: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS },
    direct: { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true },
  };
  for (const language of LANGUAGES) {
    for (const [kind, transport] of Object.entries(transports)) {
      it(`${language}, ${kind}: says how this client reaches the DHT in the page's language, the protocol names kept as names`, () => {
        const { engine } = renderApp(<NetworkSettings />, { language });
        act(() => engine.update({ transport, settings: { relays: RELAYS } }));
        const line = screen.getByTestId("network-protocol");
        // Not the engine's English (kept for logs and the CLI), whatever the language.
        expect(line).not.toHaveTextContent(transport.protocol);
        const key = kind === "direct" ? "network.protocolDirect" : "network.protocolRelays";
        const expected = lookup(language, key)!.replace("{{dht}}", "Mainline DHT (BEP44)").replace("{{pkarr}}", "Pkarr");
        expect(line.textContent).toBe(expected);
        // Each name its own isolate, so its brackets stay on their side in an Arabic sentence.
        expect([...line.querySelectorAll("bdi")].map((bdi) => bdi.textContent).sort()).toEqual(["Mainline DHT (BEP44)", "Pkarr"]);
        expect(line).toHaveAttribute("data-kind", kind);
      });
    }
  }
});

describe("Settings, Network: Iroh relays", () => {
  const DEFAULTS = ["https://use1-1.relay.n0.iroh.link/", "https://euc1-1.relay.n0.iroh.link/"];
  const transport = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS, iroh: { relays: DEFAULTS, defaults: DEFAULTS } };

  it("takes the defaults written with the trailing dot for the defaults, and keeps a relay of the person's own as typed", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    const field = screen.getByTestId("network-iroh-relays");
    // As Iroh itself names them, with the trailing dot: the same relays, stored as "none chosen".
    await user.clear(field);
    await user.type(field, DEFAULTS.map(url => url.replace("link/", "link./")).join("\n"));
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { irohRelays: [] } });
    await user.clear(field);
    await user.type(field, "https://relay.example.com/");
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { irohRelays: ["https://relay.example.com/"] } });
  });

  it("says only why a plain http:// relay elsewhere than this machine is refused, not \"Something went wrong\" first", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    // As the engine refuses it (packages/browser/src/engine/node.ts).
    engine.on("updateSettings", ({ settings }) => {
      const problem = (settings as { irohRelays?: string[] }).irohRelays?.map(irohRelayProblem).find(Boolean);
      if (problem) throw new Error(problem);
    });
    const field = screen.getByTestId("network-iroh-relays");
    await user.clear(field);
    await user.type(field, "http://relay.example.org/");
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error").textContent).toBe("Use an https:// relay address: http://relay.example.org/");
  });

  it("says a relay that is not an address in the app's language, with what was typed", async () => {
    const { engine, user } = renderApp(<NetworkSettings />, { language: "pt" });
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    engine.on("updateSettings", ({ settings }) => {
      const problem = (settings as { irohRelays?: string[] }).irohRelays?.map(irohRelayProblem).find(Boolean);
      if (problem) throw new Error(problem);
    });
    const field = screen.getByTestId("network-iroh-relays");
    await user.clear(field);
    await user.type(field, "relay.example.org");
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error").textContent).toBe("Não é um endereço de relay: relay.example.org");
    // The engine's refusal names the address typed in the Iroh list: said under that list, which is marked and focused.
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Não é um endereço de relay: relay.example.org");
    expect(field).toHaveFocus();
  });
});

describe("Settings, Network: push relay", () => {
  const transport = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };

  it("refuses a plain http:// push relay before saving, in the app's language, with what was typed", async () => {
    const { engine, user } = renderApp(<NetworkSettings />, { language: "pt" });
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    await user.type(screen.getByTestId("network-push-relay"), "http://push.example.org/");
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error").textContent).toBe("Use https:// no endereço do relay: http://push.example.org/");
    expect(engine.callsTo("updateSettings")).toEqual([]);
  });
});

describe("Settings, Network: Iroh relays on the Desktop", () => {
  it("shows them, with what a relay is for where Iroh connects directly when it can", async () => {
    const DEFAULTS = ["https://use1-1.relay.n0.iroh.link/"];
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true, iroh: { relays: DEFAULTS, defaults: DEFAULTS } }, settings: { relays: RELAYS } }));
    const row = screen.getByTestId("network-iroh-field");
    const text = await info(user, row);
    expect(text).toHaveTextContent(/directly when it can/);
    expect(text).not.toHaveTextContent(/A browser cannot/);
    await user.clear(within(row).getByTestId("network-iroh-relays"));
    await user.type(within(row).getByTestId("network-iroh-relays"), "http://127.0.0.1:3340/");
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { irohRelays: ["http://127.0.0.1:3340/"] } });
  });
});

describe("Settings, Network: HyperDHT relay", () => {
  it("is offered in a browser, and not on the Desktop, which runs HyperDHT itself and ignores it", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS }, settings: { relays: RELAYS } }));
    expect(screen.getByTestId("network-hyperdht-relay")).toBeInTheDocument();
    act(() => engine.update({ transport: { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true }, settings: { relays: RELAYS, hyperdhtRelay: "wss://relay.example.org" } }));
    expect(screen.queryByTestId("network-hyperdht-relay")).toBeNull();
    expect(screen.queryByText("HyperDHT relay")).toBeNull();
    // Saving the rest leaves the relay as it is (a web app standing by for this profile may still use it).
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).not.toHaveProperty("settings.hyperdhtRelay");
  });

  it("left empty, says only that there is no HyperDHT: the Iroh relays above it are a fallback too", () => {
    const { engine } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS, iroh: { relays: [], defaults: ["https://relay.example.org/"] } }, settings: { relays: RELAYS } }));
    expect(screen.getByTestId("network-iroh-relays")).toBeInTheDocument();
    expect(screen.getByText("Optional fallback when WebRTC fails. Empty: no HyperDHT.")).toBeInTheDocument();
    expect(screen.queryByText(/WebRTC only/)).toBeNull();
  });
});

describe("Settings, Network: TURN server", () => {
  const transport = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };

  it("says what is missing before saving, and saves the address, username and credential together", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    await user.type(screen.getByLabelText("TURN server URL"), "turn:turn.example.org:3478");
    await user.type(screen.getByLabelText("TURN username"), "ghost");
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error")).toHaveTextContent("needs its username and credential");
    expect(engine.callsTo("updateSettings")).toEqual([]);

    expect(screen.getByLabelText("TURN credential")).toHaveAttribute("type", "password");
    engine.on("updateSettings", () => undefined);
    await user.type(screen.getByLabelText("TURN credential"), "test-credential");
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { iceServers: [{ urls: "turn:turn.example.org:3478", username: "ghost", credential: "test-credential" }] } });
    expect(screen.queryByTestId("network-error")).toBeNull();
    expect(screen.getByTestId("network-saved")).toBeInTheDocument();
  });

  it("refuses an address that is not TURN or STUN", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    await user.type(screen.getByLabelText("TURN server URL"), "https://turn.example.org");
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error")).toHaveTextContent("is not a TURN or STUN address");
    expect(engine.callsTo("updateSettings")).toEqual([]);
  });

  it("a server restored from a backup asks for its credential again", async () => {
    // The fields load once, from the settings the engine has when Settings opens.
    fakeEngine.setState({ transport, settings: { relays: RELAYS, iceServers: [{ urls: "turn:turn.example.org:3478", username: "ghost" }] } } as never);
    const { user } = renderApp(<NetworkSettings />);
    const field = screen.getByTestId("network-turn-field");
    expect(field).toHaveTextContent("Enter the credential again: backups leave it out.");
    expect(screen.getByLabelText("TURN server URL")).toHaveValue("turn:turn.example.org:3478");
    await user.type(screen.getByLabelText("TURN credential"), "x");
    expect(field).not.toHaveTextContent("Enter the credential again");
    expect(field).toHaveTextContent("Used only when a direct connection fails.");
  });
});

describe("Settings, Network: addresses in a right-to-left language", () => {
  it("reads every relay and server address left to right, so a wrapped Iroh relay keeps its trailing slash at the end", () => {
    const iroh = ["https://use1-1.relay.n0.iroh.link/"];
    const { engine } = renderApp(<NetworkSettings />, { language: "ar" });
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS, iroh: { relays: iroh, defaults: iroh } }, settings: { relays: RELAYS } }));
    const addresses = [
      screen.getByTestId("network-relays"), screen.getByTestId("network-iroh-relays"), screen.getByTestId("network-hyperdht-relay"),
      screen.getByTestId("network-push-relay"), screen.getByLabelText(arNetwork.turnUrl), screen.getByLabelText(arNetwork.turnUsername),
    ];
    for (const field of addresses) expect(field).toHaveAttribute("dir", "ltr");
  });
});

describe("Settings, Network: a refused field is said in the page's language, under it, and gets the focus", () => {
  const transport = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };
  /** Every field of the page a refusal can be about, so a test can say none but the refused ones is marked. */
  const fields = () => [
    screen.getByTestId("network-relays"), screen.getByTestId("network-hyperdht-relay"), screen.getByTestId("network-push-relay"),
    document.getElementById("network-turn-url")!, document.getElementById("network-turn-username")!, document.getElementById("network-turn-credential")!,
  ];
  const marked = () => fields().filter((field) => field.getAttribute("aria-invalid") === "true").map((field) => field.id);

  it("ar: a HyperDHT relay that is not wss:// and a push relay with a login in it, each under its own field", async () => {
    const { engine, user } = renderApp(<NetworkSettings />, { language: "ar" });
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    const hyperdht = screen.getByTestId("network-hyperdht-relay");
    const push = screen.getByTestId("network-push-relay");
    await user.type(hyperdht, "http://relay.example.org");
    await user.type(push, "https://me:secret@push.example.org");
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings")).toEqual([]);
    // Not "Use a wss:// relay address" in an Arabic page.
    expect(hyperdht).toHaveAccessibleDescription("استخدم wss:// في عنوان المرحّل");
    expect(push).toHaveAccessibleDescription("أزِل اسم المستخدم وكلمة المرور من العنوان");
    expect(marked()).toEqual(["network-hyperdht-relay", "network-push-relay"]);
    // The error sits right under the field that points at it.
    const said = document.getElementById(hyperdht.getAttribute("aria-describedby")!)!;
    expect(said.previousElementSibling).toBe(hyperdht);
    // The first field refused, in page order, has the focus: not Save.
    expect(hyperdht).toHaveFocus();
    // Mended, the field is no longer marked; the next Save goes to what is still wrong.
    await user.clear(hyperdht);
    await user.type(hyperdht, "wss://relay.example.org");
    expect(hyperdht).not.toHaveAttribute("aria-invalid");
    expect(hyperdht).not.toHaveAttribute("aria-describedby");
    await user.click(screen.getByTestId("network-save"));
    expect(marked()).toEqual(["network-push-relay"]);
    expect(push).toHaveFocus();
  });

  it("pt: an address that is not one, in either relay field, says which scheme it takes", async () => {
    const { engine, user } = renderApp(<NetworkSettings />, { language: "pt" });
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    const hyperdht = screen.getByTestId("network-hyperdht-relay");
    const push = screen.getByTestId("network-push-relay");
    await user.type(hyperdht, "relay.example.org");
    await user.type(push, "push.example.org");
    await user.click(screen.getByTestId("network-save"));
    expect(hyperdht).toHaveAccessibleDescription("Informe um endereço de relay (wss://…)");
    expect(push).toHaveAccessibleDescription("Informe um endereço de relay (https://…)");
    expect(marked()).toEqual(["network-hyperdht-relay", "network-push-relay"]);
    expect(hyperdht).toHaveFocus();
    expect(engine.callsTo("updateSettings")).toEqual([]);
  });

  it("ar: a TURN address that is not TURN or STUN, and then the missing credential, each on its own field", async () => {
    const { engine, user } = renderApp(<NetworkSettings />, { language: "ar" });
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    const url = screen.getByLabelText(arNetwork.turnUrl);
    await user.type(url, "https://turn.example.org");
    await user.click(screen.getByTestId("network-save"));
    expect(url).toHaveAccessibleDescription("ليس عنوان TURN أو STUN (مثل turn:host:port): https://turn.example.org");
    expect(marked()).toEqual(["network-turn-url"]);
    expect(url).toHaveFocus();
    await user.clear(url);
    await user.type(url, "turn:turn.example.org:3478");
    await user.type(screen.getByLabelText(arNetwork.turnUsername), "ghost");
    await user.click(screen.getByTestId("network-save"));
    const credential = screen.getByLabelText(arNetwork.turnCredential);
    expect(credential).toHaveAccessibleDescription("يحتاج خادم TURN إلى اسم المستخدم وبيانات الاعتماد");
    expect(marked()).toEqual(["network-turn-credential"]);
    expect(credential).toHaveFocus();
    expect(engine.callsTo("updateSettings")).toEqual([]);
  });

  it("an engine refusal of an empty Pkarr list marks that list; one about no field stays by Save, and moves no focus", async () => {
    const { engine, user } = renderApp(<NetworkSettings />, { language: "pt" });
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    let refusal = "Enter at least one relay address (https://…)";
    engine.on("updateSettings", () => { throw new Error(refusal); });
    const relays = screen.getByTestId("network-relays");
    await user.clear(relays);
    await user.click(screen.getByTestId("network-save"));
    expect(relays).toHaveAccessibleDescription("Informe pelo menos um endereço de relay");
    expect(marked()).toEqual(["network-relays"]);
    expect(relays).toHaveFocus();
    refusal = "The relays did not answer";
    await user.click(screen.getByTestId("network-save"));
    expect(marked()).toEqual([]);
    expect(screen.getByTestId("network-error")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("network-save")).toHaveFocus();
  });
});
