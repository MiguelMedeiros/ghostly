---
section: Fixed / CLI
---
- A bot that serves apps no longer reads its list of served apps again at every repeated open from a contact. It reads it again only once `ghostly app serve` or `app unserve` changed it, or when a contact opens another version of an app, so an app served since is still taken from its next open.
