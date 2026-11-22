# When a call can't connect

Your chats work, but a call says **"The call couldn't connect"**. Most often the network blocks the direct path a call needs.

## Why it happens

A call goes straight between the two devices (WebRTC), over UDP. Chats can go through Ghostly's relays over HTTPS, so they keep working. Calls can't use those relays. When UDP is blocked, the call finds no path and gives up after a few seconds.

UDP is often blocked by:

- a VPN in "stealth", "TCP" or "obfuscated" mode, or a VPN that blocks everything except port 443;
- an office, school, hotel or airport Wi-Fi;
- some mobile carriers and corporate firewalls.

The block can be on your side or on your contact's side. Ghostly can't tell which: it only sees that no path worked.

## What to try

1. **Try another network.** Switch from Wi-Fi to mobile data, or the other way round. If the call connects, the network was the problem.
2. **Change your VPN's mode.** Pick a protocol that allows UDP (WireGuard, or OpenVPN over UDP), or turn the VPN off for the call. Ask your contact to do the same if they use one.
3. **Add a TURN server** in **Settings, Network, TURN server**. A TURN server relays the call when no direct path works. A call still goes direct whenever it can: the relay is the last path tried.

Ghostly doesn't run a TURN server for you yet. You can run your own, or use one you already have access to.

## Setting a TURN server

In **Settings, Network, TURN server**, enter:

- **TURN server** (the field that starts with `turn:`): one or more addresses, separated by commas. For a network that only lets port 443 out, use TURN over TLS on 443:
  `turns:turn.example.org:443?transport=tcp, turn:turn.example.org:3478`
- **Username** and **Credential**: the ones your TURN server gives you.

Then tap **Save** and call again. The person on the blocked network is the one who needs it; when both networks block UDP, both do.

## When a TURN server is already set

If the call still can't connect, it didn't get through your TURN server either. Check, in **Settings, Network, TURN server**:

- **The address.** A `turn:` address on port 3478 doesn't get out of a network that only lets port 443 out. Add TURN over TLS on 443 (`turns:turn.example.org:443?transport=tcp`), and make sure the server listens there.
- **The credential.** A wrong username or credential fails the same way as a blocked network. A restored backup leaves the credential out: the page then says **"Enter the credential again"**.
- **Your contact's side.** When their network blocks UDP too, they may need a TURN server of their own.

## Running your own TURN server

[coturn](https://github.com/coturn/coturn) is the common choice. You need a server with a public address, a domain name and a TLS certificate for it. A minimal `/etc/turnserver.conf`:

```
listening-port=3478
tls-listening-port=443
fingerprint
lt-cred-mech
user=ghostly:choose-a-long-password
realm=turn.example.org
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

Open TCP 443, TCP and UDP 3478, and the relay ports (UDP 49152-65535 by default) in the server's firewall. In Ghostly, the username is `ghostly` and the credential is the password after the colon.

## What a TURN server sees

The call stays end-to-end encrypted (DTLS-SRTP): the TURN server never hears or sees it. It does see both IP addresses, when the call happens and how much data it carries. A voice call is about 50 kbit/s; video is more. Use a server you trust.

With **Hide my IP from contacts** on, every call already goes through your TURN server; see [WISP 101](wisps/101-webrtc.md#your-own-turn-server).
