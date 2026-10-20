---
section: Fixed / Groups
---
- Coming back to a busy community, where many people joined and left while you were away, no longer rewrites the whole community on disk once per change. Changes caught up are now saved at most once a second, as messages are. A change to your own place in the group, such as being removed, is still saved at once. Before, 1,000 changes meant about 1,000 full writes, 241 MB in the CLI's store.
