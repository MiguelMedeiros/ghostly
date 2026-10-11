---
section: For developers / CLI
---
- `ghostly pin <chat|group> --remove` unpins. Before, it failed with "Missing <message>", and the message id it asked for was never read: any word beside `--remove` unpinned whatever was pinned. A script that names a message beside `--remove` goes on working.
