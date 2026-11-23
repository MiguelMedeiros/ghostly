---
section: Fixed / Chat
---
- In the web app, a chat that is not live counts a text against the about 248 bytes the DHT carries once sealed (about 214 for an edit), not 256, and counts each new line, quote or backslash as the two bytes it takes there. Past that the count turns amber and its tooltip says what Send will do: refused in a chat on DHT only, held, or sent once you are live. A multi-line or quoted text no longer reads as fitting and is then refused, an edit's count no longer says 256, and when both you and your contact keep a chat on DHT only, the refusal says that both of you need to change it.
