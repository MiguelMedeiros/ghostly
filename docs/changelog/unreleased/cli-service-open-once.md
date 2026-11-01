---
section: Fixed / CLI
---
- Two `ghostly service open` of the same contact service at once now open one local server and answer the same link, which `ghostly service close` closes. Before, each opened its own, and the first stayed open after `service close`, its link still reaching the contact's app until the daemon stopped.
