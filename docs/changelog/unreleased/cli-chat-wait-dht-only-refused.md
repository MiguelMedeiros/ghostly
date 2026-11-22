---
section: Fixed / CLI
release: 1.14
---
- `chat wait --until live` on a chat this side keeps on DHT only is now refused at once as `chat connect` refuses it (`refused`, exit 1, `details.reason` `dht-only`), also when this side turns the chat DHT only during the wait. Before, it waited the whole `--timeout` (up to a day), then ended `timeout`, exit 4, which a script retries. A chat the contact keeps on DHT only, or one this side holds there (`chat disconnect --hold`), is still waited for: the contact's choice may already be taken back, and a hold ends by itself.
