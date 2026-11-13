import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { openServiceView } from "../../../../web/src/svc/opener";
import { SERVICE_VIEW_ID, closeServiceView, parseServicesHost } from "../../../../web/src/svc/protocol";
import { renderApp } from "../render";

// covers: services.web-open

/**
 * A contact's app opened from the chat's Shared services dialog is drawn over that dialog: the Escape that closes the
 * app is spent there, and the dialog the person opened it from is still open under it, as ✕ leaves it.
 */
const words = { unreachable: "", failed: "", close: "Close", callOn: "", tooSlow: "", offline: "", retry: "", blocked: "", unguarded: "", label: "Demo", owner: "Not Ghostly", hostError: () => null };

beforeAll(() => {
  // happy-dom would load the bridge page from the network: nothing here needs it.
  const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
  if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
});

afterEach(() => closeServiceView());

it("Escape on a contact's app closes the app alone, not the Shared services dialog under it", async () => {
  const onClose = vi.fn();
  renderApp(<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={onClose} />);
  expect(screen.getByTestId("chat-services")).toBeInTheDocument();
  await openServiceView({ host: parseServicesHost("https://*.svc.ghostly.example")!, tag: "ybndrfg8ejkmcpqx", peer: "o".repeat(52), service: "demo", title: "Demo", send: () => new Promise(() => {}), words });
  const close = screen.getByTestId("service-view-close");
  expect(document.activeElement).toBe(close);

  fireEvent.keyDown(close, { key: "Escape" });
  expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  expect(onClose).not.toHaveBeenCalled();

  // The next Escape is the dialog's.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
