---
section: Fixed / Chat
---
- A chat that was live on Iroh when the app quit or crashed comes back in about 3 s when Iroh's relay is out of reach at the restart, over HyperDHT, instead of 20 to 23 s: the app waited 10 s for its Iroh to start, then 8 s more before it tried HyperDHT. It now tries the contact's other direct connections while it waits.
