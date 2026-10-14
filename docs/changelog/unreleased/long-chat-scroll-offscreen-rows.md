---
section: Fixed / Chat
---
- Scrolling up a long chat on a slower phone or computer still stuttered each time older messages came in. The messages off screen are now skipped when the chat is drawn, so the time the page spends frozen while you scroll is down by about a third. This applies to the web app (except in Safari), Android, and the Windows app.
- A jump to a message a screen or two away (a search's older or newer match, a quote, the pinned message) still glides all the way there, where it went the last part of the way in one leap with the messages off screen skipped.
