---
section: Fixed / CLI
---
- A CLI whose Pkarr relay takes a couple of seconds to answer reads a contact's newer packet from it again, instead of an older copy the DHT handed back first. And polls of a key nobody has published yet, which slow relays take seconds to answer, no longer each look the key up on the DHT as well.
