---
section: Fixed / Everywhere
---
- Desktop: a profile that is on this computer only no longer checks every 5 seconds whether to keep the computer awake. With no second device the answer was always "no", and each check read the profile's device state from the database and from a file on disk: 12 times a minute for as long as the app ran. It now asks once, and starts checking again when a device is added.
