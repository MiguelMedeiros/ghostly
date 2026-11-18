import { describe, expect, it, vi } from "vitest";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { AddDeviceDialog } from "../../components/devices/AddDeviceDialog";
import { TakeoverDialog } from "../../components/devices/TakeoverDialog";
import { UseHereDialog } from "../../components/devices/Handoff";
import { renderApp } from "../render";
import type { EnrollView } from "@ghostly/browser/devices/enroll";
// covers: devices.takeover, devices.handoff, devices.enroll

/*
 * What a screen reader and a keyboard meet on the device dialogs: why Take over is still off, which refusal marks the
 * password wrong, a wait that is not an alert, what the device code's QR is called, and the digits said one by one.
 */
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const waiting = { role: "inviter" as const, step: "waiting" as const, code: "ghostly1zexample", expires: Math.floor(Date.now() / 1000) + 600 };

/** Add a device as far as its code: a new lock password set, then the code the engine makes. */
async function toCode(engineView: () => EnrollView) {
  const rendered = renderApp(<AddDeviceDialog onClose={() => {}} />);
  rendered.engine.on("deviceEnrollInvite", () => waiting);
  rendered.engine.on("deviceHandoffVerifier", () => undefined);
  rendered.engine.on("deviceEnrollView", engineView);
  await rendered.user.type(screen.getByTestId("device-add-password"), "long enough");
  await rendered.user.type(screen.getByTestId("device-add-password-again"), "long enough");
  await rendered.user.click(screen.getByTestId("device-add-next"));
  await screen.findByTestId("device-add-code");
  return rendered;
}

describe("the device dialogs, for a screen reader and a keyboard", () => {
  it("Take over says why it is off while Lost or stolen is unanswered, and Enter goes to the question", async () => {
    const { user, engine } = renderApp(<TakeoverDialog device="iPhone" password onClose={() => {}} />);
    await user.type(screen.getByTestId("takeover-password"), "a long lock password");
    await user.type(screen.getByLabelText("Type iPhone to confirm"), "iPhone");
    const go = screen.getByTestId("takeover-go");
    expect(go).toBeDisabled();
    // The button names what is missing, and so does a line under the fields.
    expect(go).toHaveAccessibleDescription("Answer “Lost or stolen?” first.");
    expect(screen.getByTestId("takeover-lost-first")).toHaveTextContent("Answer “Lost or stolen?” first.");
    // Enter in a field goes to the question instead of doing nothing.
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("takeover-lost-yes")).toHaveFocus();
    expect(engine.callsTo("deviceTakeover")).toHaveLength(0);
    // Answered: the line and the description go, and Take over is on.
    await user.click(screen.getByTestId("takeover-lost-no"));
    expect(screen.queryByTestId("takeover-lost-first")).toBeNull();
    expect(go).toBeEnabled();
    expect(go).not.toHaveAttribute("aria-describedby");
  });

  it("an input method's Enter in the name stays in the name while Lost or stolen is unanswered", async () => {
    const { user } = renderApp(<TakeoverDialog device="私のiPhone" password onClose={() => {}} />);
    await user.type(screen.getByTestId("takeover-password"), "a long lock password");
    const name = screen.getByTestId("takeover-name");
    await user.click(name);
    // The Enter that confirms a candidate: composing, and WebKit's, right after the composition ended, as 229.
    fireEvent.keyDown(name, { key: "Enter", isComposing: true });
    expect(name).toHaveFocus();
    fireEvent.keyDown(name, { key: "Enter", keyCode: 229 });
    expect(name).toHaveFocus();
    // WebKit's other order: the composition ends first, then the Enter that confirmed it, saying neither.
    fireEvent.compositionEnd(name, { data: "私" });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(name).toHaveFocus();
    // A plain Enter still goes to the question.
    fireEvent.keyDown(name, { key: "Enter" });
    expect(screen.getByTestId("takeover-lost-yes")).toHaveFocus();
  });

  it("Use here marks the password wrong only when the password was refused, pointing at the reason, the field to retype", async () => {
    const { user, engine } = renderApp(<UseHereDialog device="MacBook" onClose={() => {}} onStarted={() => {}} />);
    let reply = "handoff-unreachable: Can't reach the active device.";
    engine.on("deviceHandoffPull", () => { throw new Error(reply); });
    const field = screen.getByTestId("handoff-password");
    await user.type(field, "the password");
    await user.click(screen.getByTestId("handoff-start"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach MacBook.");
    // Not the password's fault: the field is not marked.
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).not.toHaveAttribute("aria-describedby");
    reply = "handoff-password: Wrong password.";
    await user.click(screen.getByTestId("handoff-start"));
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveAccessibleDescription(screen.getByRole("alert").textContent ?? "");
    expect(field).toHaveFocus();
    expect([(field as HTMLInputElement).selectionStart, (field as HTMLInputElement).selectionEnd]).toEqual([0, "the password".length]);
  });

  it("Take over's wait is said as news, not as a red alert", async () => {
    const { user, engine } = renderApp(<TakeoverDialog password={false} ownSet onClose={() => {}} />);
    engine.on("deviceTakeover", () => ({ kind: "wait" }));
    await user.click(screen.getByTestId("takeover-go"));
    const notice = await screen.findByTestId("takeover-error");
    expect(notice).toHaveTextContent("Waiting for the network. Try again in a moment.");
    expect(notice).toHaveAttribute("data-tone", "wait");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(notice.closest("[role=status]")).not.toBeNull();
  });

  it("Take over's wait is said from a live line there before it, as one that comes with its text is often not read", async () => {
    const { user, engine } = renderApp(<TakeoverDialog password={false} ownSet onClose={() => {}} />);
    let answer!: (outcome: { kind: "wait" }) => void;
    engine.on("deviceTakeover", () => new Promise((resolve) => { answer = resolve; }));
    const live = () => [...screen.getByTestId("takeover-dialog").querySelectorAll<HTMLElement>("[role=status], [aria-live]")];
    const before = live();
    await user.click(screen.getByTestId("takeover-go"));
    await screen.findByTestId("takeover-checking");
    answer({ kind: "wait" });
    const notice = await screen.findByTestId("takeover-error");
    const saying = live().filter((region) => region.contains(notice));
    expect(saying).toHaveLength(1);
    expect(before).toContain(saying[0]);
    // Asked again and still waiting: the line empties while it checks, and says the wait again after.
    await user.click(screen.getByTestId("takeover-go"));
    await waitFor(() => expect(saying[0]).toBeEmptyDOMElement());
    answer({ kind: "wait" });
    await waitFor(() => expect(saying[0]).toHaveTextContent("Waiting for the network. Try again in a moment."));
  });

  it("Take over's wrong password points the field at its reason", async () => {
    const { user, engine } = renderApp(<TakeoverDialog device="iPhone" password onClose={() => {}} />);
    engine.on("deviceTakeover", () => { throw new Error("takeover-password: Wrong password."); });
    await user.click(screen.getByTestId("takeover-lost-no"));
    await user.type(screen.getByTestId("takeover-password"), "a long lock password");
    await user.type(screen.getByLabelText("Type iPhone to confirm"), "iPhone");
    await user.click(screen.getByTestId("takeover-go"));
    expect(await screen.findByTestId("takeover-error")).toHaveTextContent("Wrong password.");
    expect(screen.getByTestId("takeover-password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("takeover-password")).toHaveAccessibleDescription("Wrong password.");
  });

  it("Add a device names its QR for the device code, not an invite", async () => {
    await toCode(() => waiting);
    const svg = screen.getByTestId("invite-qr").querySelector("svg");
    expect(svg?.querySelector("title")).toHaveTextContent("Device code QR code");
  });

  it("Add a device says the digits one by one, as the new device does", async () => {
    let view: EnrollView = waiting;
    await toCode(() => view);
    view = { role: "inviter", step: "confirm", digits: "482913", device: "Pixel", kind: "web" };
    const spoken = screen.getByTestId("device-add-spoken");
    await waitFor(() => expect(spoken).toHaveTextContent("Found Pixel. Check that it shows the same digits. 4 8 2 9 1 3"), { timeout: 3_000 });
  });
});
