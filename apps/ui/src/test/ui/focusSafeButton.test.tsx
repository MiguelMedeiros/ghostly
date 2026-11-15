import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FocusSafeButton } from "../../components/ui/FocusSafeButton";
import { Button } from "../../components/wallet/ui";
import { renderApp } from "../render";

// covers: app.accessibility

/**
 * A button pressed from the keys that its own work (or the field it saved, now unchanged) disables: browsers drop the
 * focus of a disabled control to the page, where it stays when the work fails. happy-dom keeps the focus on a disabled
 * button, so these check what the button is (`disabled` or `aria-disabled`); e2e probes check the focus in Chromium.
 */
function Work({ as, work }: { as: "raw" | "button"; work: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const press = () => { setBusy(true); void work().catch(() => undefined).finally(() => setBusy(false)); };
  return <>
    {as === "raw" ? <FocusSafeButton data-testid="go" disabled={busy} onClick={press}>Go</FocusSafeButton> : <Button data-testid="go" disabled={busy} onClick={press}>Go</Button>}
    <button type="button" data-testid="other">Other</button>
  </>;
}

describe.each(["raw", "button"] as const)("a %s button disabled by its own work", (as) => {
  it("stays focusable while it works and after it fails, its presses ignored, then plain disabled once the focus leaves", async () => {
    let fail: (() => void) | undefined;
    const work = vi.fn(() => new Promise<void>((_, refuse) => { fail = () => refuse(new Error("no")); }));
    const { user } = renderApp(<Work as={as} work={work} />);
    const go = screen.getByTestId("go");
    go.focus();
    await user.keyboard("{Enter}");
    expect(work).toHaveBeenCalledTimes(1);
    expect(go).toBeEnabled();
    expect(go).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(work, "a press while it works").toHaveBeenCalledTimes(1);
    await act(async () => fail!());
    expect(go).toBeEnabled();
    expect(go).not.toHaveAttribute("aria-disabled");
    await user.keyboard("{Enter}");
    expect(work, "pressed again after the failure").toHaveBeenCalledTimes(2);
    // The focus leaves while it works: disabled as asked, out of the Tab order.
    await user.tab();
    expect(go).toBeDisabled();
    expect(go).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the focus while the window is away during its work: another tab or app blurs it but leaves it the page's focus", async () => {
    const work = vi.fn(() => new Promise<void>(() => undefined));
    const { user } = renderApp(<Work as={as} work={work} />);
    const go = screen.getByTestId("go");
    go.focus();
    await user.keyboard("{Enter}");
    // What Chromium does when the tab or window goes to the back: blur on the button, which stays document.activeElement
    // (natively disabled there, Chromium moves the focus to the page, and it is on the page when the window is back).
    act(() => { go.dispatchEvent(new FocusEvent("blur")); go.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(document.activeElement).toBe(go);
    expect(go).toBeEnabled();
    expect(go).toHaveAttribute("aria-disabled", "true");
    await user.tab();
    expect(go).toBeDisabled();
  });

  it("is usable again when its work fails after the window came back", async () => {
    let fail: (() => void) | undefined;
    const { user } = renderApp(<Work as={as} work={() => new Promise<void>((_, refuse) => { fail = () => refuse(new Error("no")); })} />);
    const go = screen.getByTestId("go");
    go.focus();
    await user.keyboard("{Enter}");
    act(() => { go.dispatchEvent(new FocusEvent("blur")); go.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    act(() => { go.dispatchEvent(new FocusEvent("focus")); go.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    await act(async () => fail!());
    expect(go).toBeEnabled();
    expect(go).not.toHaveAttribute("aria-disabled");
    await user.keyboard("{Enter}");
    expect(go, "pressed again after the failure").toHaveAttribute("aria-disabled", "true");
  });

  it("is plain disabled when it was disabled before it had the focus", () => {
    renderApp(as === "raw" ? <FocusSafeButton data-testid="go" disabled>Go</FocusSafeButton> : <Button data-testid="go" disabled>Go</Button>);
    expect(screen.getByTestId("go")).toBeDisabled();
    expect(screen.getByTestId("go")).not.toHaveAttribute("aria-disabled");
  });
});

it("a held submit button sends no form on Enter", async () => {
  const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
  function Form() {
    const [name, setName] = useState("Ada");
    const [saved, setSaved] = useState("Ada");
    return <form onSubmit={(e) => { submit(e); setSaved(name); }}>
      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <FocusSafeButton type="submit" data-testid="save" disabled={name === saved}>Save</FocusSafeButton>
    </form>;
  }
  const { user } = renderApp(<Form />);
  await user.type(screen.getByLabelText("Name"), "!");
  screen.getByTestId("save").focus();
  await user.keyboard("{Enter}");
  expect(submit).toHaveBeenCalledTimes(1);
  // Saved: unchanged now, so disabled, and still focused.
  expect(screen.getByTestId("save")).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Enter}");
  expect(submit).toHaveBeenCalledTimes(1);
});

/**
 * A raw `<button disabled={busy}>` in the app's components drops the focus as above: FocusSafeButton (or the wallet's
 * Button) instead. The files left are other open pull requests' or held ones, each to follow.
 */
const COMPONENTS = join(fileURLToPath(import.meta.url), "../../../components");
const LEFT = new Set(["voice/VoiceRecorderButton.tsx", "JoinDialog.tsx", "NewGroupDialog.tsx", "GroupMembersDialog.tsx", "identities/ComposerIdentities.tsx"]);
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".tsx") ? [join(dir, entry.name)] : []);

it("no raw button in the components is disabled while its work runs", () => {
  const found = files(COMPONENTS).filter((file) => !LEFT.has(relative(COMPONENTS, file))).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/<button\b(?:=>|[^>])*?\sdisabled=\{[^}]*\b(?:busy|working|pending|running|saving|sending|turning)\b/g)]
      .map((match) => `${relative(COMPONENTS, file)}: ${match[0].slice(0, 80).replace(/\s+/g, " ")}`));
  expect(found).toEqual([]);
});
