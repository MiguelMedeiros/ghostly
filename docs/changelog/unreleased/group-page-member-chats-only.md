---
section: Fixed / Groups
---
- An open group's page costs less when you have many chats: it no longer copies every one of your 1:1 chats, picture included, each time the app's state changes (several times a second while a file moves or links check in), only the chats of the group's members who are your contacts. With 500 chats, about 0.3 ms down to under 0.04 ms a change on a fast machine; with 2,000, about 1 ms down to 0.2 ms. A contact who is not in the group changing their picture, or a new contact, no longer redraws the group's page.
