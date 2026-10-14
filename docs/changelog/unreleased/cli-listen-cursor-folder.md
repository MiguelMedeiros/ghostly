---
section: Fixed / CLI
---
- `ghostly listen --cursor <file>` whose folder does not exist, or cannot be written, is refused at once (`not_found`, exit 3, or `refused`, exit 1), before the profile is opened. Before, it started and ran: each event printed "event N failed: ENOENT" on stderr, the cursor was never written, and the next start skipped what came while it was down.
