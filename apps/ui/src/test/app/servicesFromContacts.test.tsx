import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
