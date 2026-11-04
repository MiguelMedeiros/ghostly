import { useState } from "react";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Segmented } from "../../components/wallet/ui";
import { renderApp } from "../render";

// covers: app.theme, app.accessibility

const OPTIONS = [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }] as const;
type Mode = (typeof OPTIONS)[number]["value"];

function Mode({ onChange, disabled }: { onChange: (next: Mode) => void; disabled?: boolean }) {
  const [value, setValue] = useState<Mode>("light");
  return <Segmented label="Mode" value={value} disabled={disabled} options={[...OPTIONS]} onChange={next => { onChange(next); setValue(next); }} />;
}

function open({ disabled }: { disabled?: boolean } = {}) {
  const onChange = vi.fn();
  const view = renderApp(<Mode onChange={onChange} disabled={disabled} />);
  const group = screen.getByRole("radiogroup", { name: "Mode" });
  const radio = (name: string) => within(group).getByRole("radio", { name });
  const focused = () => document.activeElement?.textContent;
  return { ...view, group, radio, focused, onChange };
}

/**
 * The Segmented choice (Profile's light/dark Mode, a backup's content and protection, a wallet's network and where it
 * receives) was a radiogroup whose every option was its own Tab stop, and the arrow keys did nothing in it. Now it is
 * one Tab stop (the chosen option) and the arrows, Home and End move between the options, as TransportOptions does;
 * Space or Enter chooses, since choosing may be an action (a wallet's network replaces it).
 */
describe("a Segmented choice, by keyboard", () => {
  it("is one Tab stop, the chosen option", async () => {
    const { user, radio, focused } = open();
    expect(OPTIONS.map(o => radio(o.label).tabIndex)).toEqual([-1, 0, -1]);
    const before = document.createElement("button");
    before.textContent = "before";
    document.body.prepend(before);
    before.focus();
    await user.tab();
    expect(focused()).toBe("Light");
    await user.tab();
    expect(OPTIONS.map(o => o.label as string)).not.toContain(focused()); // out of the group
    before.remove();
  });

  it("moves with the arrows, around the ends, Home and End; Space chooses", async () => {
    const { user, radio, focused, onChange } = open();
    radio("Light").focus();
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("Dark");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("System"); // around the end
    await user.keyboard("{ArrowUp}");
    expect(focused()).toBe("Dark");
    await user.keyboard("{Home}");
    expect(focused()).toBe("System");
    await user.keyboard("{End}");
    expect(focused()).toBe("Dark");
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(OPTIONS.map(o => radio(o.label).tabIndex)).toEqual([-1, -1, 0]);
  });

  it("in Arabic, Left goes on and Right goes back", async () => {
    const { user, group, radio, focused } = open();
    group.style.direction = "rtl";
    radio("Light").focus();
    await user.keyboard("{ArrowLeft}");
    expect(focused()).toBe("Dark");
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("Light");
  });

  it("while it is held, keeps its one Tab stop on the chosen option", () => {
    const { radio } = open({ disabled: true });
    expect(OPTIONS.map(o => radio(o.label).tabIndex)).toEqual([-1, 0, -1]);
  });
});
