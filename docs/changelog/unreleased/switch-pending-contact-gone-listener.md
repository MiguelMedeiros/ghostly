---
section: Fixed / Everywhere
---
- A chat whose contact closed the app while a change of transport was still connecting lets its Iroh and HyperDHT listeners go again while the contact is away. Before, the change it had started held them until the contact came back or the app restarted, so on the Desktop and in the browser that chat could keep a listener slot another chat needed.
