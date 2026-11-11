---
section: Fixed / Web
---
- On the web, a contact's shared app that sets up its own Trusted Types default policy starts again. Since 1.11.1 it failed at start; now the app's own policy is used (what it has no rule for, such as a script it loads by address, passes as it does outside Ghostly), and Ghostly still refuses `javascript:` links in it.
