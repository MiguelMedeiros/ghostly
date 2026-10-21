---
section: Fixed / CLI
---
- `chat pay` and `chat request` to a contact that has no wallet yet are refused with `refused`, "Your contact has no wallet yet: they need one to pay or be paid", and `details.reason` `contact_no_wallet`. Before, both answered `engine`, "This contact does not support payments. Both peers need an updated Ghostly.", even when both ran the same release. A contact with payments off in the chat, or an older app, is `refused` with `contact_payments_off`. The payment-bot example tells the person in the chat they have no wallet yet, instead of passing on the update advice.
