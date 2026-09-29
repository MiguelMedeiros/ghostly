---
section: Fixed / Chat
---
- A transport chosen while another change of transport was still connecting is tried as soon as that change fails. Before, the chat said "waiting" with no failures and never tried it until the transport was chosen again; with Fallback off it was not live meanwhile.
