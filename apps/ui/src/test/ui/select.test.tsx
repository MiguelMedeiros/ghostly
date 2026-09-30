import { screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "../../components/ui/Select";
import { useDialogFocus } from "../../hooks/useDismiss";
import { renderApp } from "../render";
import { listOf, optionsOf, readOption } from "../select";

// covers: app.select

type Resolver = "quad9" | "cloudflare" | "google" | "gone" | "custom";
const RESOLVERS: SelectOption<Resolver>[] = [
  { value: "quad9", label: "Quad9", description: "dns.quad9.net" },
  { value: "cloudflare", label: "Cloudflare", description: "cloudflare-dns.com" },
  { value: "gone", label: "Gone resolver", disabled: true },
  { value: "google", label: "Google", description: "dns.google" },
  { value: "custom", label: "Custom" },
];

/** A select the way the app uses one: its value in the parent's state, labelled by a `<label>`. */
function Picker({ initial = "quad9", onChange = () => {}, ...props }: { initial?: Resolver | ""; onChange?: (value: Resolver) => void } & Partial<Parameters<typeof Select<Resolver>>[0]>) {
  const [value, setValue] = useState<Resolver | "">(initial);
  return <>
    <label htmlFor="resolver">Domain lookups</label>
    <Select id="resolver" options={RESOLVERS} {...props} value={value} onChange={(next) => { setValue(next); onChange(next); }} />
    <button type="button">After</button>
  </>;
}

const combobox = () => screen.getByRole("combobox", { name: "Domain lookups" });
const active = () => {
  const id = combobox().getAttribute("aria-activedescendant");
  return id ? readOption(document.getElementById(id)!).value : null;
};

describe("Select", () => {
  describe("what it is to a screen reader", () => {
    it("is a combobox named by its label, showing the chosen option's name and description", () => {
      renderApp(<Picker />);
      expect(combobox()).toHaveAttribute("aria-haspopup", "listbox");
      expect(combobox()).toHaveAttribute("aria-expanded", "false");
      expect(combobox()).toHaveAttribute("data-value", "quad9");
      expect(combobox()).toHaveTextContent("Quad9 dns.quad9.net");
    });

    it("takes its name from aria-label or aria-labelledby too", () => {
      renderApp(<>
        <span id="heading">Lock after</span>
        <Select aria-labelledby="heading" value="1" onChange={() => {}} options={[{ value: "1", label: "1 minute" }]} />
        <Select aria-label="Language" value="en" onChange={() => {}} options={[{ value: "en", label: "English" }]} />
      </>);
      expect(screen.getByRole("combobox", { name: "Lock after" })).toHaveTextContent("1 minute");
      expect(screen.getByRole("combobox", { name: "Language" })).toHaveTextContent("English");
    });

    it("shows the placeholder while nothing is chosen", () => {
      renderApp(<Picker initial="" placeholder="5 available…" />);
      expect(combobox()).toHaveTextContent("5 available…");
      expect(combobox()).toHaveAttribute("data-value", "");
    });

    it("opens a listbox named like it, each option named by its first line and described by its second", async () => {
      const { user } = renderApp(<Picker />);
      await user.click(combobox());
      expect(combobox()).toHaveAttribute("aria-expanded", "true");
      const list = screen.getByRole("listbox", { name: "Domain lookups" });
      expect(combobox()).toHaveAttribute("aria-controls", list.id);
      const quad9 = within(list).getByRole("option", { name: "Quad9" });
      expect(quad9).toHaveAccessibleDescription("dns.quad9.net");
      expect(quad9).toHaveAttribute("aria-selected", "true");
      expect(within(list).getByRole("option", { name: "Google" })).toHaveAttribute("aria-selected", "false");
      expect(within(list).getByRole("option", { name: "Gone resolver" })).toHaveAttribute("aria-disabled", "true");
      // The chosen option is the one the reader is on.
      expect(combobox()).toHaveAttribute("aria-activedescendant", quad9.id);
    });

    it("keeps focus on the combobox while the list is open", async () => {
      const { user } = renderApp(<Picker />);
      await user.click(combobox());
      await user.keyboard("{ArrowDown}");
      expect(combobox()).toHaveFocus();
    });
  });

  describe("the keyboard", () => {
    it("opens on ArrowDown on the chosen option, moves over disabled ones, chooses with Enter", async () => {
      const onChange = vi.fn();
      const { user } = renderApp(<Picker onChange={onChange} />);
      await user.tab();
      expect(combobox()).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(combobox()).toHaveAttribute("aria-expanded", "true");
      expect(active()).toBe("quad9");
      await user.keyboard("{ArrowDown}{ArrowDown}");
      expect(active()).toBe("google");
      await user.keyboard("{ArrowUp}");
      expect(active()).toBe("cloudflare");
      await user.keyboard("{Enter}");
      expect(onChange).toHaveBeenCalledWith("cloudflare");
      expect(combobox()).toHaveAttribute("aria-expanded", "false");
      expect(combobox()).toHaveAttribute("data-value", "cloudflare");
      expect(combobox()).toHaveFocus();
    });

    it("stops at the ends, and Home/End go to the first and last usable option", async () => {
      const { user } = renderApp(<Picker />);
      await user.tab();
      await user.keyboard("{End}");
      expect(combobox()).toHaveAttribute("aria-expanded", "true");
      expect(active()).toBe("custom");
      await user.keyboard("{ArrowDown}");
      expect(active()).toBe("custom");
      await user.keyboard("{Home}");
      expect(active()).toBe("quad9");
      await user.keyboard("{ArrowUp}");
      expect(active()).toBe("quad9");
    });

    it("opens with Space and chooses with Space", async () => {
      const onChange = vi.fn();
      const { user } = renderApp(<Picker onChange={onChange} />);
      await user.tab();
      await user.keyboard(" ");
      expect(combobox()).toHaveAttribute("aria-expanded", "true");
      await user.keyboard("{ArrowDown} ");
      expect(onChange).toHaveBeenCalledWith("cloudflare");
      expect(combobox()).toHaveAttribute("aria-expanded", "false");
    });

    it("closes on Escape without choosing, and the Escape goes no further", async () => {
      const onChange = vi.fn();
      const onClose = vi.fn();
      function InDialog() {
        const ref = useRef<HTMLDivElement>(null);
        useDialogFocus(ref, onClose);
        return <div ref={ref} role="dialog" tabIndex={-1}><Picker onChange={onChange} /></div>;
      }
      const { user } = renderApp(<InDialog />);
      await user.click(combobox());
      await user.keyboard("{ArrowDown}{Escape}");
      expect(combobox()).toHaveAttribute("aria-expanded", "false");
      expect(combobox()).toHaveAttribute("data-value", "quad9");
      expect(onChange).not.toHaveBeenCalled();
      // The dialog it sits in is still open; a second Escape is the dialog's.
      expect(onClose).not.toHaveBeenCalled();
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("chooses the active option on Tab and lets focus move on", async () => {
      const onChange = vi.fn();
      const { user } = renderApp(<Picker onChange={onChange} />);
      await user.click(combobox());
      await user.keyboard("{ArrowDown}");
      await user.tab();
      expect(onChange).toHaveBeenCalledWith("cloudflare");
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
      expect(combobox()).toHaveAttribute("aria-expanded", "false");
    });
  });

  describe("typing a name", () => {
    it("opens on the next option starting with the letter, and the same letter again goes on, round to the top", async () => {
      const { user } = renderApp(<Picker options={[...RESOLVERS, { value: "cloudflare-2" as Resolver, label: "Cloudflare family" }]} />);
      await user.tab();
      await user.keyboard("c");
      expect(combobox()).toHaveAttribute("aria-expanded", "true");
      expect(active()).toBe("cloudflare");
      await user.keyboard("c");
      expect(active()).toBe("custom");
      await user.keyboard("c");
      expect(active()).toBe("cloudflare-2");
      await user.keyboard("c");
      expect(active()).toBe("cloudflare");
    });

    it("adds letters typed in quick succession, skips disabled options, and starts over after a pause", async () => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const { user } = renderApp(<Picker />);
      await user.click(combobox());
      await user.keyboard("g");
      // "Gone resolver" is disabled: Google.
      expect(active()).toBe("google");
      // After a pause, "c" starts a new search: the next option with a C after Google.
      now += 1_000;
      await user.keyboard("c");
      expect(active()).toBe("custom");
      // Quickly after: "cl", which Custom does not start with.
      now += 100;
      await user.keyboard("l");
      expect(active()).toBe("cloudflare");
      now += 100;
      // No option starts with "clx": where it was.
      await user.keyboard("x");
      expect(active()).toBe("cloudflare");
    });
  });

  describe("the mouse", () => {
    it("chooses the option clicked; a disabled one does nothing", async () => {
      const onChange = vi.fn();
      const { user } = renderApp(<Picker onChange={onChange} />);
      await user.click(combobox());
      await user.click(screen.getByRole("option", { name: "Gone resolver" }));
      expect(onChange).not.toHaveBeenCalled();
      expect(combobox()).toHaveAttribute("aria-expanded", "true");
      await user.click(screen.getByRole("option", { name: "Google" }));
      expect(onChange).toHaveBeenCalledWith("google");
      expect(combobox()).toHaveAttribute("aria-expanded", "false");
      expect(combobox()).toHaveFocus();
    });

    it("closes without choosing on a press elsewhere", async () => {
      const onChange = vi.fn();
      const { user } = renderApp(<Picker onChange={onChange} />);
      await user.click(combobox());
      await user.click(screen.getByRole("button", { name: "After" }));
      expect(combobox()).toHaveAttribute("aria-expanded", "false");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("clicking the label opens it, as the label names it", async () => {
      const { user } = renderApp(<Picker />);
      await user.click(screen.getByText("Domain lookups"));
      expect(combobox()).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("does nothing when disabled", async () => {
    const { user } = renderApp(<Picker disabled />);
    expect(combobox()).toBeDisabled();
    await user.click(combobox());
    expect(combobox()).toHaveAttribute("aria-expanded", "false");
  });

  it("submits its value with a form through a hidden input when named", () => {
    const { container } = renderApp(<form><Picker name="resolver" /></form>);
    expect(Object.fromEntries(new FormData(container.querySelector("form")!))).toEqual({ resolver: "quad9" });
  });

  it("puts its list inside the modal dialog it sits in, where the dialog keeps it usable", async () => {
    const { user } = renderApp(<dialog open><Picker /></dialog>);
    await user.click(combobox());
    expect(listOf(combobox()).closest("dialog")).not.toBeNull();
  });

  it("reads back what it offers (the helper the other tests use)", async () => {
    const { user } = renderApp(<Picker />);
    expect(await optionsOf(user, combobox())).toEqual([
      { value: "quad9", label: "Quad9", description: "dns.quad9.net", disabled: false, selected: true },
      { value: "cloudflare", label: "Cloudflare", description: "cloudflare-dns.com", disabled: false, selected: false },
      { value: "gone", label: "Gone resolver", description: undefined, disabled: true, selected: false },
      { value: "google", label: "Google", description: "dns.google", disabled: false, selected: false },
      { value: "custom", label: "Custom", description: undefined, disabled: false, selected: false },
    ]);
    expect(combobox()).toHaveAttribute("aria-expanded", "false");
  });
});
