---
section: Fixed / Chat
---
- A chat that leaves DHT only on both sides goes live in seconds even when your app has just used up its share of the
  relays. Before, your app could read your contact once as the chat left DHT only and then wait about 40 seconds to read
  again, so it missed your contact's offer or did not see that your contact had left DHT only too. The chat stayed on
  "On DHT · retrying live" until then.
