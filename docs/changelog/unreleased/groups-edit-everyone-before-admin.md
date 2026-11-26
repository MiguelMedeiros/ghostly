---
section: Fixed / Groups
release: 1.14
---
- In a private group, an edit that adds @everyone to a message sent before you became the group's admin is refused with a clear message, in the app and in `group edit --mention everyone` (exit 1, `refused`), and nothing changes. It went out without the mention while your own copy showed @everyone and the CLI answered as sent: members take @everyone in an edit only of a message sent while its author was the admin.
