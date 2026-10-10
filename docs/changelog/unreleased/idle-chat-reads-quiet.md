---
section: Fixed / Everywhere
---
- With many chats and nothing happening, the app no longer redraws the whole chat list about once a second. Each routine read of a chat's link or mailbox used to send the whole app state to the page. Now the state goes out only when something the list shows changes, or for the chat that is open.
