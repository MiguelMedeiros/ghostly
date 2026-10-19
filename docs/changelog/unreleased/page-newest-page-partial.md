---
section: For developers
---
- A page that gets a chat's newest page from the engine (a `messages` event with `more`) keeps it as part of the chat, not the whole of it: what came goes into the chat, and the chat still says how many older messages it left out. `engine.whole(linkId)` says which kind a page has, `engine.askWhole(linkId)` asks the engine for the rest (once per connection), and `engine.keepWhole(linkId)` holds a chat whole for a reader that shows all of it, asking again whenever only its newest page comes. The page asks by itself when the newest page and what the chat holds do not make its whole history together. Nothing sends a newest page yet.
