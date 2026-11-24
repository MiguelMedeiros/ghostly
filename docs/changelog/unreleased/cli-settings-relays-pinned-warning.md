---
section: Fixed / CLI
---
- `ghostly settings set relays` (or `irohRelays`) while `GHOSTLY_PKARR_RELAYS` (or `GHOSTLY_IROH_RELAYS`) is set where the profile runs now says on stderr that only the variable's relays are used and the setting is kept for later. Before, it answered with exit 0 and said nothing, while `status` went on naming the variable's relays.
