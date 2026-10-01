---
section: Fixed / Chat
---
- A chat between the Linux Desktop and the web app is live again sooner when the web app restarts first: the Desktop's first connection after its own restart could open and then carry nothing, and it waited 30 s for that connection to time out before dialling again (about 35 s in all). It now gives up such a connection after 15 s, as the web app already did, and dials again at once, or at once when the web app's record shows a newer address for it.
