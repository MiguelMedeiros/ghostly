---
section: Fixed / CLI
---
- When the CLI's store fails to finish writing its snapshot (a `message delete --purge` on a nearly full disk, or a backup whose file rename fails), a daemon killed later no longer comes back with settings, chats' keys and other state lost since that failure, while their messages stayed. The failed snapshot used to be picked up at the next start in place of the journal that held them.
