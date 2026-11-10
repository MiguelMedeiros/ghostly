---
section: For users / Chat
release: 1.11
---
- The installed web app, closed, can now tell you a contact came online: "Ana is online" (or "A contact is online" when it doesn't know the name), at most once every 30 minutes per contact, never for muted chats or groups. Settings → Notifications, "Notify me when a contact comes online", right under "Wake me while closed": on by default, and it can be turned off; turned off, your app shows no online notice even from a contact whose app has not heard of it yet. The contact's app sends the push, so your browser's push service learns when your contacts come online. An app with many such contacts tells ten a minute, so a call or message wake-up it sends meanwhile still goes through its push relay.
