---
section: For developers / Bots
---
- `GHOSTLY_PKARR_RELAYS=http://…,…` keeps a CLI profile on your own Pkarr relays from its very first run, as on the Desktop, and leaves the public Mainline DHT out unless `GHOSTLY_DHT_BOOTSTRAP` is set. The README now says to set the relays before the first `daemon` on a private network.
- The echo bot example keeps its cursor in the Ghostly folder in use (`GHOSTLY_HOME`) instead of always `~/.ghostly`, and the README documents `ECHO_CURSOR`.
- The README and `ghostly help send` say that everything after `--` is message text, options like `--wait sent` included.
