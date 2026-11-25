---
section: Fixed / CLI
---
- `identity remove` run without a daemon, on a proof shared in a chat, publishes its revocation before it ends: it ended before the revocation reached any relay, so contacts who check found none until a daemon started on that profile.
