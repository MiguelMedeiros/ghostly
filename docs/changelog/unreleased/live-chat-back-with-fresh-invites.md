---
section: Fixed / Chat
---
- With many contacts, reloading the page (or opening the app again) a few minutes after making New chat invites no longer leaves your live chats on "On DHT · retrying live" for a minute. A chat coming back used to wait about 60 seconds, against 8 without the invites, because it held its reads for the contact's answer behind an invite's packet that could not go out until the relays' minute freed. It now reads that answer at once, within the small allowance already kept for connecting chats.
