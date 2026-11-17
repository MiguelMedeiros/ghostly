---
section: Fixed / CLI
---
- `ghostly listen --webhook https://…` with a bridge whose TLS fails (a self-signed certificate, or a plain http server) says so on stderr, with the error's name and the way out: give it as `http://`, or restart `listen` with `NODE_EXTRA_CA_CERTS`. The event is still held until the bridge takes it. Before, stderr said the bridge was "not answering", while it answered every try, and waiting changed nothing.
