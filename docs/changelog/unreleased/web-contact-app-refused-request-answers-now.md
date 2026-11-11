---
section: Fixed / Web
---
- In the web app, a request a contact's shared app made that the web app does not take (a very long address, as a search with a long query makes, or a method written in lowercase such as `patch`) is now refused at once, in your language. Before, the app's page waited 75 seconds for it and then said in English that the app did not answer in time.
