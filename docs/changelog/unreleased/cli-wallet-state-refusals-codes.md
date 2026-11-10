---
section: Fixed / CLI
---
- A payment's state that refuses a wallet command is said with its own code, not `engine` (which a bot reads as the engine failing and may retry): `payment reclaim` of a payment the contact already took, or of a request, `chat pay-request` of a request that is no longer open and `pay` of an invoice already paid are `refused`; `payment check` of your own payment or request is `bad_request`, naming what it is; a mint that has not answered a payment's swap is `unavailable` (try again later).
