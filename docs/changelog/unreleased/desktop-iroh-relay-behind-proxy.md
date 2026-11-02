---
section: Fixed / Everywhere
---
- The Desktop app connects to a self-hosted Iroh relay behind a proxy, such as a Cloudflare tunnel. It used to add a trailing dot to the relay's name, which the proxy did not recognize, so Iroh never came online on that relay.
