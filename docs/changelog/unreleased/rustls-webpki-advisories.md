---
section: For developers
---
- The Rust builds (Desktop, native transports and Iroh for browsers) take rustls-webpki 0.103.16, webpki-roots 1.0.10 and webpki-root-certs 1.0.10, which stop trusting the distrusted emSign intermediates (RUSTSEC-2026-0381, RUSTSEC-2026-0382, RUSTSEC-2026-0383). The dependency scan is green again.
