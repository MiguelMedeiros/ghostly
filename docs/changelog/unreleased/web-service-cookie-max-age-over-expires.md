---
section: Fixed / Web
---
- A contact's service opened in the web app keeps a cookie whose `Max-Age` is still ahead even when its `Expires` reads past (the contact's clock behind this device's), and one with an empty `Max-Age`, as a browser does. Both were dropped, so the service logged the person out on every request.
