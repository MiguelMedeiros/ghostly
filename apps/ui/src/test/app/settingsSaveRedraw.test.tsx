import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSettings } from "../../contexts/SettingsContext";
import { renderApp } from "../render";

/*
 * A setting changed in this page is saved over what is stored now (another tab may have changed the rest). The saved
 * copy is a new object even when it holds the same settings: taken as it is, it drew everything that reads the settings
 * a second time (the app shell, the chat, the sidebar, the theme, the language) on every fold of the chat list.
 */

const KEY = "ghostly_app_settings";

function renderReader() {
  const counter = { draws: 0 };
  function Reader() {
    const { settings, updateChatListCollapsed } = useSettings();
    counter.draws++;
    return (
      <button data-testid="fold" data-sounds={String(settings.notifications.soundEnabled)} onClick={() => updateChatListCollapsed(!settings.chatListCollapsed)}>
        {String(settings.chatListCollapsed)}
      </button>
    );
  }
  renderApp(<Reader />);
  return counter;
}

const fold = () => act(() => { fireEvent.click(screen.getByTestId("fold")); });
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as { chatListCollapsed?: boolean; notifications?: { soundEnabled?: boolean } };

describe("a setting changed in this page", () => {
  afterEach(() => { localStorage.clear(); });

  it("draws what reads the settings once", () => {
    const counter = renderReader();
    fold();
    counter.draws = 0;
    fold();
    expect(screen.getByTestId("fold").textContent).toBe("false");
    expect(stored().chatListCollapsed).toBe(false);
    expect(counter.draws).toBe(1);
  });

  it("still takes what another tab stored in the meantime", () => {
    renderReader();
    fold();
    localStorage.setItem(KEY, JSON.stringify({ ...stored(), notifications: { ...stored().notifications, soundEnabled: false } }));
    fold();
    expect(screen.getByTestId("fold").dataset.sounds).toBe("false");
    expect(stored()).toMatchObject({ chatListCollapsed: false, notifications: { soundEnabled: false } });
  });
});
