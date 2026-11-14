---
section: Fixed / CLI
---
- A daemon whose contacts are away spends less CPU waiting for the relays' request budget. Each request the budget held back copied the minute's request lists twice each and kept a stack trace for its "retry shortly" answer, thousands of times a minute with many contacts away. It now reads the lists as they are and makes that answer without a stack: about a fifth less CPU at 200 contacts away, with the same requests going out.
