---
section: Fixed / CLI
release: 1.14
---
- `chat wait --until live` on a chat on DHT only, by this side's choice or the contact's, is now refused at once as `chat connect` refuses it (`refused`, exit 1, `details.reason` `dht-only` or `peer-dht-only`), also when the chat turns DHT only during the wait. Before, it waited the whole `--timeout` (up to a day), then ended `timeout`, exit 4, which a script retries. A chat this side holds on DHT only (`chat disconnect --hold`) is still waited for: it goes live when the hold ends.
