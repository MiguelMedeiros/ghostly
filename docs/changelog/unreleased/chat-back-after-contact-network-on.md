---
section: Fixed / Chat
---
- When a contact turns their network back on, a chat whose first connection attempt fails at once (their app had not opened its connection point again yet) tries again 3 seconds later, not 40 seconds later. Before, that chat came back about 40 seconds after the others.
