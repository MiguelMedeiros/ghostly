---
section: Fixed / Calls
---
- A call from the web app, and the macOS, Windows and Android apps, no longer opens ten spare network sessions it never uses: it asks the public STUN servers about 25 times instead of over 100, and with a TURN server in Settings → Network it takes 4 relay allocations instead of 20, so a server with a per-user quota no longer refuses most of them. Calls connect as fast as before.
