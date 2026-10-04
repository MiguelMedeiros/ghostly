# One profile on several devices

Use the same profile on your computer and your phone: the same chats, groups, identities, settings and wallets. One device is **active** at a time and the others wait on **standby**. Only the active device sends, receives and pays, so your messages and money are never in two places. When you pick up another device, **Use here** moves the profile to it.

It works in the web app (installed on a phone too), the browser extension and the desktop app. Your contacts see nothing new: no notice, no new chat. The design is [WISP 06](wisps/06-devices.md).

## Add a device

1. On the device you use now: **Profile → Devices → Add a device**. A profile on several devices needs a lock password of 8 characters or more; Ghostly asks you to set one, or to make yours longer, first.
2. It shows a code, good for 10 minutes.
3. On the new device, open Ghostly and choose **I already use Ghostly → Add this device to my profile**, name this device, then scan or paste the code.
4. Both devices show the same six digits. Check them, then tap **They match** on the device you use now.

The new device is now on standby, and it offers to bring the profile over at once. Up to 4 devices per profile.

On iPhone and iPad, add Ghostly to the Home Screen first: a Safari tab keeps its own storage, which the browser may clear. Elsewhere, Ghostly asks the browser to keep its data and says so when it does not.

## Move the profile

- **Use here**, on a device on standby, asks for the profile's lock password and pulls the profile from the active device. The active device checks the password without ever seeing it; five wrong tries in an hour lock that device out for an hour.
- **Move to <device>**, on the active device's Devices list, offers the profile to another device that is on. Say **Use here** there.

Files are copied first while you keep using the active device; later moves copy only new files. On mobile data, files over 16 MB can stay behind (**Bring large files later**). Then the active device stops, sends the rest, and goes on standby once the other device has checked it all. The new device waits about 30 seconds to be sure no other device took over at the same moment, then reconnects to your contacts.

Both devices must be online, with Ghostly open, for the whole move. On a desktop, **Keep this computer awake** (Profile → Devices) keeps it from sleeping, so your phone can take over while you are out. A move that stops (a dropped connection, no answer for 2 minutes) changes nothing, and **Try again** keeps the files already copied.

A phone on standby still gets a quiet notice for a message or a call ("New message. Active on <device>."), which opens its standby screen.

## Wallets

Testnet ecash, Spark, Lightning through NWC or Core Lightning, LND without a pinned certificate and the on-chain BDK wallet move with the profile.

- **Mainnet money keeps the profile where it is for now.** Empty your Mainnet wallets first, or keep using that device.
- Ark, Bark, Fedimint, USDT, Bitcoin Core and LND with a pinned certificate stay on the device they were made on. The other devices show them as "On <device>" and never open them.
- Ark and Bark coins that expire in under 3 days keep the profile on their device until you renew them.
- A payment still going through holds the move for up to 30 seconds.

## A lost or broken device

- **My other device is lost or broken**, on a device on standby that has held the profile before, takes over without the active device. It asks for the lock password and the name of the device that stops. You get the profile as it was when it last ran on this device: what reached the other device after that is not here. If the other device comes back, it stops without a word to your contacts, and offers **It wasn't me**.
- After a takeover, or a restored backup, this copy does not manage your groups (changes, letting people in) until you turn on **Manage groups from this device** in that group.
- **Remove**, in a device's menu on the active device, takes it out of the profile: your devices move to a new device secret it never gets. The others learn the new list the next time they are open together. **Lost or stolen** then lists what to do: change your storage keys, move the money out of each wallet the lost device could spend from, and pair each chat again.
- A device that was removed says so when it opens, and can be added again.

## Restoring a backup

A backup of a profile on several devices does not start while another device is active. The app offers **Add this device instead**, **Take over**, or cancel. See [backups](wisps/05-backups.md).

## When the network is down

Before it goes online, Ghostly checks which device is active. When it cannot (no relay answers), it asks first: **Try again**, or **Start anyway**, which opens the profile offline: you can read and write, and nothing is sent, paid or received until the check works. It tries again every 30 seconds.

## Limits

- One active device at a time: two devices live at once is not part of this.
- Both devices online for a move. There is no pickup while the active device is off.
- Each switch has about half a minute in which no device is active.
- A device that was active keeps a frozen copy of the profile when it goes on standby, unencrypted, so a lost phone means Remove and the checklist above.
- The [CLI](CLI.md) keeps one profile per folder and is not part of it; a bot moves with `profile backup` and `profile restore`.
