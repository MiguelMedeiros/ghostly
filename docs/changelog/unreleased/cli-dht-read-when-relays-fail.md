---
section: Fixed / CLI
---
- When the Pkarr relays start failing after they had worked, the CLI reads its contacts from the Mainline DHT at once, instead of handing back the relays' last copy for about 40 seconds, and its status shows the DHT path.
