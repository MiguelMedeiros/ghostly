---
section: Fixed / Web
---
- In the web app, a contact's shared app no longer pulls a whole answer off the contact's link (up to 32 MiB each) when the app's page does not read it, such as a paused video or a download it holds: the page now takes an answer only about 1 MiB ahead of what the app reads, so the contact's upload and this browser's memory are not spent on what is never shown.
