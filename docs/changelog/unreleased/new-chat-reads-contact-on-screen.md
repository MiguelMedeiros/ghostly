---
section: Fixed / Chat
---
- In the web app, the extension and the desktop app, a chat you just made and have open now looks for its contact over the DHT every 10 seconds, as an open chat does. It looked only every 30 seconds, as for a chat in the background, so when the contact chose DHT only right after the chat went live, your side could keep saying "On DHT · retrying live" for a minute before it said "DHT only · chosen by your contact".
