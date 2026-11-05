---
section: Fixed / Groups
---
- In a private group, an app closed or killed while it sent a message no longer gives its next message the same id. Before, the first message showed as sent but never reached anyone, and the members showed the next one in its place. Now that message is sent once the app opens again, or, when the app stopped before keeping it, is not shown at all.
