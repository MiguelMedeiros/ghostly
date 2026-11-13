---
section: Fixed / CLI
---
- `ghostly listen --group` now passes the group's `payment.created` and `payment.updated` events (a request to the group, a member paying it). Before, every one of them was dropped, since a payment event names a chat and never the group. A group's payment no longer passes `--from` for the chat it went through: `--group` lets it in.
