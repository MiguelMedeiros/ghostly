---
section: Fixed / CLI
---
- `ghostly chat remove` closes the contact's services opened from that chat with `service open`. Before, each stayed on its loopback port until the daemon stopped, answering every request with a 503, and `service close` could no longer close it (`No chat`). A service stays open while another chat with the same contact is left.
