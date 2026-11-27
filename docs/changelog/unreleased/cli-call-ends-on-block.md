---
section: Fixed / CLI
---
- `ghostly engine setContactBlocked` during a call with that contact now ends the call, as Block contact does in the app. A call that only rings here stops with nothing sent to the contact. A call that is on, or rings on their side, hangs up and the contact hears it. Before, the call stayed up: a ring until it went stale, and a call that was on until its sound stopped, because a blocked contact's hang-up is no longer heard.
