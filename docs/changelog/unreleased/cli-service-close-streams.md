---
section: Fixed / CLI
---
- `service close` answers at once while a contact's app is still streaming to a page, and ends that stream, on the contact's side too. Before, it waited for as long as the page stayed open and the stream kept coming.
