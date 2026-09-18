import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBrowserHost } from "@ghostly/browser/host";
import { startSessionSync } from "@ghostly/browser/platform/sync";
import { Root } from "../../src/Root";
import { becomeThePeer } from "@ghostly/browser/inPageHost";
import { webHost } from "./host";

// The same UI and the same peer as the extension; only the host differs.
const root = createRoot(document.getElementById("root")!);

await becomeThePeer("ghostly-peer", () =>
  root.render(
    <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "#0b141a", color: "#8696a0", font: "15px system-ui", textAlign: "center", padding: 24 }}>
      <div>
        <div style={{ fontSize: 48 }}>👻</div>
        <p>Ghostly is already open in another tab.</p>
        <p style={{ fontSize: 13 }}>Close it and this tab takes over.</p>
      </div>
    </div>,
  ),
);

setBrowserHost(webHost);
startSessionSync();
addEventListener("pagehide", () => webHost.announceDeparture());

root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
