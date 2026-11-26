---
section: Fixed / CLI
---
- The CLI checks the signature of each group frame, record and packet it takes with Node's Ed25519 instead of the app's portable one: about 0.17 ms a check instead of 2.8 ms. In a busy community this was most of the daemon's CPU; 240 messages in a 48-member community now take 6 s of the engines' time instead of 33 s. What a check accepts is unchanged.
