---
section: Fixed / Chat
---
- A chat that leaves DHT only goes live even when your app has just used up its share of the relays (back from Offline,
  say). Before, if your contact's first try did not get through and it tried again at once, your app could miss the new
  try and keep answering the old one, and the chat stayed on "On DHT · retrying live".
