---
section: Fixed / Chat
---
- After the app starts again, a chat whose first connection attempt fails at once tries again 3 seconds later, not 40 seconds later. Before, that chat came back about 40 seconds after the others. While a chat waits before its next attempt, it also stops reading the contact every 0.7 seconds, because those reads could not connect it any sooner: 45 reads in that wait went down to a few.
