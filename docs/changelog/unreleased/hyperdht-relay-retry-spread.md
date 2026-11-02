---
section: Fixed / Web
---
- After a HyperDHT relay restarts, each web app listens on it again at a time of its own, between 15 and 45 seconds
  later, rather than every app at the same instant 30 seconds later. On a relay full of apps (512), about a fifth of
  their chats' listens timed out in that burst and stayed without HyperDHT for longer.
