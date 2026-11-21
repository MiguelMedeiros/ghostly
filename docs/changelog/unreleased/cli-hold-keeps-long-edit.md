---
section: Fixed / CLI
release: 1.14
---
- In a chat held on the DHT for a while (`ghostly chat disconnect --hold`), an edit too long for the DHT packet (about 215 bytes and up) is no longer refused: it is kept and goes when the hold ends, as a long text does, and `edit` says when. A chat on the DHT only by choice still refuses it.
