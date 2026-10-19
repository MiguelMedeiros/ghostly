---
section: Fixed / Groups
---
- In a group on an app with no WebRTC (a Linux Desktop, a CLI), or on a VPN, every member now keeps a connection to the group. Before, with several groups, a member of the third one could keep none, and nothing sent there reached it: it kept its connection to the admin, which had none free for it. Now the admin or hub answers the connection each member keeps to it, and a member that gets no answer in 20 seconds connects to the next member instead.
