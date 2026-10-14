---
section: Fixed / Groups
---
- Communities take less CPU to carry messages. A message or a membership change that a device already has, handed to it again by a second hub or in a catch-up, is now dropped before its signature is checked. In a community of 32 members this cuts the signature checks by about 45%, and each message reaches everyone with about 40% less work.
