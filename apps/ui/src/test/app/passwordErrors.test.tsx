import { describe, expect, it, vi } from "vitest";
import { act, configure, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { AddDeviceDialog } from "../../components/devices/AddDeviceDialog";
import { Toast } from "../../components/ui/Toast";
import { useToast } from "../../hooks/useToast";
import { hashPassword } from "../../lib/settings";
import { renderApp } from "../render";
// covers: settings.lock.password, devices.enroll

/*
 * What these tests wait for sits behind the lock password's hash (600,000 rounds, twice for a change of password):
 * about 200 ms each on an idle machine, over a second on a busy runner. The default wait of 1 s is too short for that;
 * and a test gets longer than its longest wait, so one that fails still says what it waited for.
 */
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const stored = () => JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}").lockScreen?.passwordHash ?? null;

async function lockWith(password: string) {
  const hash = await hashPassword(password);
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
  return hash;
}

/** Settings for a profile with no device set, once it knows that (until then it takes the stricter rule of a set). */
async function renderSettings() {
  const result = renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>, { route: "/settings" });
  result.engine.on("deviceSet", () => ({ state: "single", devices: [] }));
  await waitFor(() => expect(result.engine.callsTo("deviceSet")).toHaveLength(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return result;
}

/** The field is marked wrong, says why under it, and has the focus with its text selected, to be typed again. */
function expectRefused(input: HTMLElement, errorTestId: string, text: string) {
  const error = screen.getByTestId(errorTestId);
  expect(error).toHaveTextContent(text);
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-describedby", error.id);
  expect(input).toHaveFocus();
  const field = input as HTMLInputElement;
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
}

describe("a refused lock password in Settings", () => {
  it("a wrong current password: said under the field and in a floating card, and the password is not changed", async () => {
    const hash = await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "not it");
    await user.type(screen.getByTestId("settings-password-new"), "second secret");
    await user.type(screen.getByTestId("settings-password-confirm"), "second secret");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    const card = await screen.findByTestId("settings-notice");
    expect(card).toHaveAttribute("data-tone", "error");
    expect(screen.getByTestId("settings-notice-title")).toHaveTextContent("Password not changed");
    expect(screen.getByTestId("settings-notice-text")).toHaveTextContent("Incorrect password");
    // Read out by screen readers: the card sits in a polite live region.
    expect(card.parentElement).toHaveAttribute("role", "status");
    expect(card.parentElement).toHaveAttribute("aria-live", "polite");
    expectRefused(screen.getByTestId("settings-password-current"), "settings-password-current-error", "Incorrect password");
    expect(stored()).toBe(hash);
    // The form stays open with what was typed.
    expect(screen.getByTestId("settings-password-new")).toHaveValue("second secret");

    // Typing straight away replaces the selected text and clears the field's error; the right one changes the password.
    await user.keyboard("first secret");
    expect(screen.getByTestId("settings-password-current")).toHaveValue("first secret");
    expect(screen.queryByTestId("settings-password-current-error")).toBeNull();
    expect(screen.getByTestId("settings-password-current")).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(stored()).not.toBe(hash));
    expect(await screen.findByTestId("settings-notice-text")).toHaveTextContent("Password changed successfully");
    expect(screen.getByTestId("settings-notice")).toHaveAttribute("data-tone", "success");
  }, 30_000);

  it("removing with a wrong current password keeps the lock", async () => {
    const hash = await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "not it");
    await user.click(screen.getByRole("button", { name: "Remove password" }));
    expect(await screen.findByTestId("settings-notice-title")).toHaveTextContent("Password not removed");
    expectRefused(screen.getByTestId("settings-password-current"), "settings-password-current-error", "Incorrect password");
    expect(stored()).toBe(hash);
  }, 30_000);

  it("too short, then not the same twice: each under its own field, with the card", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-lock"));
    await user.type(screen.getByTestId("settings-password-new"), "boo");
    await user.type(screen.getByTestId("settings-password-confirm"), "boo");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByTestId("settings-notice-title")).toHaveTextContent("Password not set");
    expectRefused(screen.getByTestId("settings-password-new"), "settings-password-new-error", "Password must be at least 4 characters");

    await user.type(screen.getByTestId("settings-password-new"), "spooky");
    await user.clear(screen.getByTestId("settings-password-confirm"));
    await user.type(screen.getByTestId("settings-password-confirm"), "spookier");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(screen.getByTestId("settings-notice-text")).toHaveTextContent("Passwords do not match"));
    expectRefused(screen.getByTestId("settings-password-confirm"), "settings-password-confirm-error", "Passwords do not match");
    expect(screen.queryByTestId("settings-password-new-error")).toBeNull();
    expect(stored()).toBeNull();
  }, 30_000);

  it("pressed before the engine said whether there is a device set: judged by its answer, not by the stricter rule", async () => {
    const result = renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>, { route: "/settings" });
    // An engine still starting: nothing answers until the test lets it.
    const waiting: (() => void)[] = [];
    result.engine.on("deviceSet", () => new Promise((resolve) => waiting.push(() => resolve({ state: "single", devices: [] }))));
    const { user } = result;
    await user.click(screen.getByTestId("settings-lock"));
    await user.type(screen.getByTestId("settings-password-new"), "boo");
    await user.type(screen.getByTestId("settings-password-confirm"), "boo");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("settings-password-new-error")).toBeNull();
    await act(async () => { for (const answer of waiting.splice(0)) answer(); });

    expect(await screen.findByTestId("settings-notice-title")).toHaveTextContent("Password not set");
    expectRefused(screen.getByTestId("settings-password-new"), "settings-password-new-error", "Password must be at least 4 characters");
    // Long enough for a profile on one device, though short of a set's 8: set.
    await user.clear(screen.getByTestId("settings-password-new"));
    await user.type(screen.getByTestId("settings-password-new"), "spooky");
    await user.clear(screen.getByTestId("settings-password-confirm"));
    await user.type(screen.getByTestId("settings-password-confirm"), "spooky");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(stored()).not.toBeNull());
  }, 30_000);
});

describe("opening the lock password form", () => {
  it("turning the lock on puts the focus in New password, ready to type", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-lock"));
    expect(screen.getByTestId("settings-password-form")).toBeInTheDocument();
    expect(screen.getByTestId("settings-password-new")).toHaveFocus();
    await user.keyboard("spooky");
    expect(screen.getByTestId("settings-password-new")).toHaveValue("spooky");
  });

  it("Change password puts the focus in Current password, again when it is closed and opened", async () => {
    await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    expect(screen.getByTestId("settings-password-current")).toHaveFocus();
    await user.click(screen.getByTestId("settings-password-edit"));
    expect(screen.queryByTestId("settings-password-form")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("settings-password-edit"));
    expect(screen.getByTestId("settings-password-current")).toHaveFocus();
  });
});

describe("closing the lock password form", () => {
  it("Cancel hands the focus back to the Lock Screen switch that opened it, not to the page", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-lock"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("settings-password-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-lock")).toHaveFocus();
  });

  it("a password set: the focus goes back to the Lock Screen switch", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-lock"));
    await user.type(screen.getByTestId("settings-password-new"), "spooky");
    await user.type(screen.getByTestId("settings-password-confirm"), "spooky");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByTestId("settings-notice-text")).toHaveTextContent("Password set successfully");
    expect(screen.queryByTestId("settings-password-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-lock")).toHaveFocus();
  }, 30_000);

  it("a password changed: the focus goes back to Change password", async () => {
    await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "first secret");
    await user.type(screen.getByTestId("settings-password-new"), "second secret");
    await user.type(screen.getByTestId("settings-password-confirm"), "second secret{Enter}");
    expect(await screen.findByTestId("settings-notice-text")).toHaveTextContent("Password changed successfully");
    expect(screen.queryByTestId("settings-password-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-password-edit")).toHaveFocus();
  }, 30_000);

  it("a password removed: Change password goes with it, so the focus goes to the Lock Screen switch", async () => {
    await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "first secret");
    await user.click(screen.getByRole("button", { name: "Remove password" }));
    expect(await screen.findByTestId("settings-notice-text")).toHaveTextContent("Password removed");
    expect(screen.queryByTestId("settings-password-edit")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-lock")).toHaveFocus();
  }, 30_000);

  it("Settings opened with the focus on the page: nothing takes it", async () => {
    await renderSettings();
    expect(document.body).toHaveFocus();
  });
});

describe("Enter in the lock password form", () => {
  it("Enter in New password or in Confirm password sets it, as the button does", async () => {
    for (const which of ["new", "confirm"]) {
      localStorage.clear();
      const { user, unmount } = await renderSettings();
      await user.click(screen.getByTestId("settings-lock"));
      await user.type(screen.getByTestId("settings-password-new"), "spooky");
      await user.type(screen.getByTestId("settings-password-confirm"), "spooky");
      await user.type(screen.getByTestId(`settings-password-${which}`), "{Enter}");
      await waitFor(() => expect(stored()).not.toBeNull());
      expect(await screen.findByTestId("settings-notice-text")).toHaveTextContent("Password set successfully");
      expect(screen.queryByTestId("settings-password-form")).not.toBeInTheDocument();
      unmount();
    }
  }, 30_000);

  it("Enter with the two not the same: the button's refusal, under Confirm, and nothing set", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-lock"));
    await user.type(screen.getByTestId("settings-password-new"), "spooky");
    await user.type(screen.getByTestId("settings-password-confirm"), "spookier{Enter}");
    await waitFor(() => expect(screen.getByTestId("settings-notice-text")).toHaveTextContent("Passwords do not match"));
    expect(screen.getByTestId("settings-notice-title")).toHaveTextContent("Password not set");
    expectRefused(screen.getByTestId("settings-password-confirm"), "settings-password-confirm-error", "Passwords do not match");
    expect(stored()).toBeNull();
    expect(screen.getByTestId("settings-password-form")).toBeInTheDocument();
  }, 30_000);

  it("Enter too short in New password: refused under it, as the button does", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-lock"));
    await user.type(screen.getByTestId("settings-password-new"), "boo{Enter}");
    expect(await screen.findByTestId("settings-notice-title")).toHaveTextContent("Password not set");
    expectRefused(screen.getByTestId("settings-password-new"), "settings-password-new-error", "Password must be at least 4 characters");
    expect(stored()).toBeNull();
  }, 30_000);

  it("Change password: Enter in Current refuses a wrong one, then changes it, and never removes it", async () => {
    const hash = await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "not it");
    await user.type(screen.getByTestId("settings-password-new"), "second secret");
    await user.type(screen.getByTestId("settings-password-confirm"), "second secret");
    await user.type(screen.getByTestId("settings-password-current"), "{Enter}");
    expect(await screen.findByTestId("settings-notice-title")).toHaveTextContent("Password not changed");
    expectRefused(screen.getByTestId("settings-password-current"), "settings-password-current-error", "Incorrect password");
    expect(stored()).toBe(hash);

    await user.keyboard("first secret{Enter}");
    await waitFor(() => expect(stored()).not.toBe(hash));
    expect(stored()).not.toBeNull();
    expect(await screen.findByTestId("settings-notice-text")).toHaveTextContent("Password changed successfully");
  }, 30_000);
});

describe("a refused lock password in Add a device", () => {
  it("a wrong password: under the field and in a card inside the dialog, and nothing starts", async () => {
    await lockWith("a long password");
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    await user.type(screen.getByTestId("device-add-password"), "not the one");
    await user.click(screen.getByTestId("device-add-next"));
    const card = await screen.findByTestId("device-add-notice");
    expect(card).toHaveTextContent("Wrong password.");
    // In the modal dialog, not behind it.
    expect(screen.getByTestId("device-add")).toContainElement(card);
    expectRefused(screen.getByTestId("device-add-password"), "device-add-password-error", "Wrong password.");
    expect(engine.callsTo("deviceHandoffVerifier")).toHaveLength(0);
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
  }, 30_000);

  it("a set that could not be made ready says so in the form and in the card", async () => {
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceHandoffVerifier", () => { throw new Error("offline"); });
    await user.type(screen.getByTestId("device-add-password"), "long enough");
    await user.type(screen.getByTestId("device-add-password-again"), "long enouhg");
    await user.click(screen.getByTestId("device-add-next"));
    expectRefused(await screen.findByTestId("device-add-password-again"), "device-add-password-again-error", "The two passwords are not the same.");
    expect(screen.getByTestId("device-add-notice")).toHaveTextContent("The two passwords are not the same.");
    await user.clear(screen.getByTestId("device-add-password-again"));
    await user.type(screen.getByTestId("device-add-password-again"), "long enough");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-error")).toHaveTextContent("This password could not be set up for moving the profile. Try again.");
    expect(screen.getByTestId("device-add-notice")).toHaveTextContent("This password could not be set up for moving the profile. Try again.");
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
  }, 30_000);

  it("the card goes with the error it repeats: once the field is typed in again", async () => {
    const { user } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    await user.type(screen.getByTestId("device-add-password"), "short");
    await user.type(screen.getByTestId("device-add-password-again"), "short");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-notice")).toHaveTextContent("Use 8 characters or more.");
    await user.keyboard("long enough");
    expect(screen.queryByTestId("device-add-password-error")).toBeNull();
    expect(screen.queryByTestId("device-add-notice")).toBeNull();
  }, 30_000);

  it("the code that comes next shows with no card from the refusal before it", async () => {
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    let refuse = true;
    engine.on("deviceHandoffVerifier", () => { if (refuse) throw new Error("offline"); });
    engine.on("deviceEnrollInvite", () => ({ role: "inviter", step: "waiting", code: "ghostly1zexample", expires: Math.floor(Date.now() / 1000) + 600 }));
    await user.type(screen.getByTestId("device-add-password"), "long enough");
    await user.type(screen.getByTestId("device-add-password-again"), "long enough");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-notice")).toHaveTextContent("This password could not be set up for moving the profile. Try again.");
    // Next again, the engine answering this time: the code, and nothing over its status.
    refuse = false;
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-code")).toBeInTheDocument();
    expect(screen.queryByTestId("device-add-notice")).toBeNull();
  }, 30_000);
});

describe("the floating card", () => {
  function Harness() {
    const notice = useToast(1_000);
    return <>
      <button type="button" onClick={() => notice.show("Saved", { tone: "success" })}>show</button>
      <Toast toast={notice.toast} onDismiss={notice.dismiss} />
    </>;
  }

  it("goes by itself after a while, or at once with its close button", async () => {
    const { user } = renderApp(<Harness />);
    // The live region is there before anything is said, so the first card is read out too.
    expect(screen.getByTestId("toast-region")).toHaveAttribute("role", "status");
    await user.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByTestId("toast")).toHaveTextContent("Saved");
    await user.click(screen.getByTestId("toast-close"));
    expect(screen.queryByTestId("toast")).toBeNull();
    await user.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByTestId("toast")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("waits while it is pointed at or its × has the focus, and its time runs again when it is left", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "show" }));
    await user.hover(screen.getByTestId("toast"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_300)));
    expect(screen.getByTestId("toast")).toBeInTheDocument();
    await user.unhover(screen.getByTestId("toast"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));
    expect(screen.queryByTestId("toast")).toBeNull();

    await user.click(screen.getByRole("button", { name: "show" }));
    await user.tab();
    expect(screen.getByTestId("toast-close")).toHaveFocus();
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_300)));
    expect(screen.getByTestId("toast")).toBeInTheDocument();
  });

  it("a focused card that goes hands the focus back to the button that brought it, not to the page", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "show" }));
    await user.tab();
    expect(screen.getByTestId("toast-close")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(screen.getByRole("button", { name: "show" })).toHaveFocus();
  });

  it("an error stays long enough to read in the app's language: Japanese takes longer than its least time", async () => {
    function Refusal() {
      const notice = useToast(1_000);
      return <>
        <button type="button" onClick={() => notice.show("パスワードは4文字以上必要です", { title: "パスワードは設定されていません" })}>show</button>
        <Toast toast={notice.toast} onDismiss={notice.dismiss} />
      </>;
    }
    const { user } = renderApp(<Refusal />, { language: "ja" });
    await user.click(await screen.findByRole("button", { name: "show" }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_500)));
    expect(screen.getByTestId("toast")).toBeInTheDocument();
  });

  it("with the keyboard up, not over the button of the focused field's form either: it goes to the top", async () => {
    function Form() {
      const notice = useToast();
      return <>
        <Toast toast={notice.toast} onDismiss={notice.dismiss} place="dialog" />
        <form onSubmit={(event) => { event.preventDefault(); notice.show("Use 8 characters or more."); }}>
          <input aria-label="password" />
          <button type="submit">Next</button>
        </form>
      </>;
    }
    // A 375×667 phone with the keyboard up (407 px left): the dialog 50-358, the field 180-224, Next 293-337; the card
    // at the bottom of what is left 329-383 (over Next's lower 8 px), at the top 60-114.
    const box = (top: number, bottom: number) => DOMRect.fromRect({ x: 16, y: top, width: 343, height: bottom - top });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches("input")) return box(180, 224);
      if (this.matches("button[type=submit]")) return box(293, 337);
      if (this.matches("[data-testid=toast]")) return this.parentElement?.dataset.at === "top" ? box(60, 114) : box(329, 383);
      return box(0, 0);
    });
    try {
      const { user } = renderApp(<Form />);
      await user.click(screen.getByRole("textbox", { name: "password" }));
      await user.keyboard("abc{Enter}");
      expect(screen.getByTestId("toast")).toHaveTextContent("Use 8 characters or more.");
      expect(screen.getByRole("textbox", { name: "password" })).toHaveFocus();
      expect(screen.getByTestId("toast-region")).toHaveAttribute("data-at", "top");
    } finally { rect.mockRestore(); }
  });
});

describe("the lock password's fields and password managers", () => {
  it("New and Confirm are not marked new-password, so Safari does not offer a generated one; Current still reads a saved one", async () => {
    await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    expect(screen.getByTestId("settings-password-current")).toHaveAttribute("autocomplete", "current-password");
    for (const which of ["new", "confirm"]) {
      const field = screen.getByTestId(`settings-password-${which}`);
      expect(field).toHaveAttribute("type", "password");
      expect(field).toHaveAttribute("autocomplete", "off");
    }
  });
});
