---
section: Fixed / Relays
---
- The HyperDHT relay's container lets in the Desktop by default, and its README says which origins the Desktop sends
  (`tauri://localhost` on macOS and Linux, `http://tauri.localhost` on Windows and Android). With Hide my IP from
  contacts on, the Desktop dials HyperDHT through the relay from its webview, and a relay set up as the README said
  refused it (403): every chat showed "HyperDHT relay unreachable". If you run your own HyperDHT relay with
  `GHOSTLY_RELAY_ORIGINS` set, add those two.
