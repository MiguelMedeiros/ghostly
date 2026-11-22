import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { engineError } from "@ghostly/core";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Services } from "../../pages/Services";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.open

const name = "Family photo album and recipe planner app XYZ";
const ana: ChatSession = { id: "ana", profile: "paired-chat/1", mySeedB64: "seed-ana", peerPubKeyB64: "peer", encKeyB64: "enc", label: "Ana", messages: [], createdAt: 1 };

beforeEach(() => {
  saveSession(ana);
  fakeEngine.update({ links: [linkView({ peerServices: [{ id: "album", type: "http", name }] })] });
});

// A 46-character name put its Open button 51 px past a 375 px phone's edge, the start of the name cut in Arabic.
describe("Services → From your contacts", () => {
  it.each(["en", "ar", "ja"] as const)("an app with a long name opens from a button no wider than the row, its name cut with an ellipsis in its own direction (%s)", async (language) => {
    renderApp(<Services />, { language });
    const open = await screen.findByTestId("contact-service-open");
    expect(open.className).toMatch(/\bmax-w-full\b/);
    expect(open.className).toMatch(/\bmin-w-0\b/);
    const label = within(open).getByTestId("contact-service-name");
    expect(label).toHaveTextContent(name);
    expect(label.className).toMatch(/\btruncate\b/);
    expect(label).toHaveAttribute("dir", "auto");
    // The verb stays whole beside the cut name, and the whole label is in the title.
    expect(open.textContent!.replace(name, "").trim()).not.toBe("");
    expect(open.getAttribute("title")).toBe(open.textContent);
  });
});

// The same for an app this device shares: in Arabic its Latin name, its address and the contacts in its People list
// lost their start where they were cut ("…ery long local web application").
describe("Services → Your apps, in Arabic", () => {
  it("cuts the app's name, its address and each contact's name and key in their own direction", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    try {
      fakeEngine.update({ services: [{ id: "mine", name: "My very long local web application name", target: "http://localhost:3400/a/long/path", enabled: true, requests: 0, createdAt: 1 }] });
      const { user } = renderApp(<Services />, { language: "ar" });
      const card = await screen.findByTestId("service-item");
      expect(within(card).getByText("My very long local web application name")).toHaveAttribute("dir", "auto");
      expect(within(card).getByText("localhost:3400/a/long/path")).toHaveAttribute("dir", "auto");

      await user.click(within(card).getByTestId("service-people"));
      const grant = within(card).getByTestId("service-grant");
      const lines = [...grant.querySelectorAll(".truncate")];
      expect(lines.map((line) => line.textContent)).toContain("Ana");
      for (const line of lines) expect(line).toHaveAttribute("dir", "auto");
    } finally {
      fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
    }
  });

  it("a chat's Services dialog: this device's apps (name and address) and the contact's", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    try {
      fakeEngine.update({ services: [{ id: "mine", name: "My very long local web application name", target: "http://localhost:3400/a/long/path", enabled: true, requests: 0, createdAt: 1 }] });
      renderApp(<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} />, { language: "ar" });
      const grant = await screen.findByTestId("chat-service-grant");
      expect(within(grant).getByText("My very long local web application name")).toHaveAttribute("dir", "auto");
      expect(within(grant).getByText("localhost:3400/a/long/path")).toHaveAttribute("dir", "auto");
      expect(within(screen.getByTestId("chat-service-from")).getByText(name)).toHaveAttribute("dir", "auto");
    } finally {
      fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
    }
  });
});

// A contact keeps only the first 16 services of what it is told (chat, voice and video first): the engine refuses a
// grant past them. The switches dropped that refusal, and an app the contact never saw read as shared.
describe("Sharing an app with a contact who already has as many as it can see", () => {
  const full = () => { throw engineError("serviceShareFull", { max: 13 }); };

  it.each(["en", "pt"] as const)("the chat's Services dialog says why under the app's switch (%s)", async (language) => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    try {
      fakeEngine.on("setServiceShared", full);
      fakeEngine.update({ services: [{ id: "mine", name: "Notes", target: "http://localhost:3400", enabled: true, requests: 0, createdAt: 1 }] });
      const { user } = renderApp(<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} />, { language });
      const grant = await screen.findByTestId("chat-service-grant");
      await user.click(within(grant).getByTestId("chat-service-toggle"));
      const problem = await within(grant).findByTestId("chat-service-grant-problem");
      expect(problem).toHaveTextContent(language === "en" ? "A contact can reach at most 13 of your apps" : "Um contato pode acessar no máximo 13 dos seus apps");
      expect(problem).toHaveTextContent(language === "en" ? "Take one back from them before sharing another." : "Retire o acesso a um deles antes de compartilhar outro.");
    } finally {
      fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
    }
  });

  it("Services → People says why under that contact's switch", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    try {
      fakeEngine.on("setServiceShared", full);
      fakeEngine.update({ services: [{ id: "mine", name: "Notes", target: "http://localhost:3400", enabled: true, requests: 0, createdAt: 1 }] });
      const { user } = renderApp(<Services />);
      const card = await screen.findByTestId("service-item");
      await user.click(within(card).getByTestId("service-people"));
      const grant = within(card).getByTestId("service-grant");
      await user.click(within(grant).getByRole("switch"));
      expect(await within(grant).findByTestId("service-grant-problem")).toHaveTextContent("A contact can reach at most 13 of your apps");
    } finally {
      fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
    }
  });
});
