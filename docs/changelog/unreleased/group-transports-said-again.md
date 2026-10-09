---
section: Fixed / Groups
---
- A member of a private group whose connection once failed on some network (a VPN, a firewall) is reachable again after the app restarts on a network that works. Before, the other members' apps kept trying the fallback route that member no longer used, and showed it as unreachable for good, whichever app was restarted. Members on 1.1.5 and 1.1.6 reach it again as soon as its app is updated.
