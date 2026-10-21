---
section: Fixed / CLI
---
- The CLI's secret guard now also covers `ghostly engine preparePayment`, `fedimintInvoice` and `lnurlInvoice`, and the `--comment` of `ghostly pay` to a Lightning address. A memo or comment that looks like a recovery phrase or a private key stops with exit 5 unless `--force`, as `chat pay --memo` already did. Before, these paths sent it to the contact or the address's owner unchecked. `pay` gains `--force`.
