---
section: Fixed / Chat
---
- Messages waiting for a contact who is away no longer keep the app busy. Each check of the contact's DHT mailbox used to re-read the whole chat even when nothing had changed; now the waiting messages are looked at only when something changes: a delivery receipt, the contact's mode, or their own retry. A CLI daemon with 30 away contacts, each with 20 waiting texts, used 11.7% of a core where 0.9% is normal.
