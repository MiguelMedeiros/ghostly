---
section: Fixed / Devices
---
- A new device can always take your profile with the password, however many devices took it before. The active
  device kept a count of password tries for every device that ever asked, removed ones too; after 16 it could not
  save the next one, and the new device waited with no answer. It now keeps the counts of the devices in your set only.
