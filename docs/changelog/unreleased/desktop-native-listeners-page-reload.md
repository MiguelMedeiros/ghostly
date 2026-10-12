---
section: Fixed / Everywhere
---
- Desktop: when the app's window loaded its page again without the old page stopping its Iroh and HyperDHT listeners (another profile opened, Clear all data, the window's own process restarted), those listeners kept running until the app was quit. Eight of each is the limit, so after a few such loads no chat could go live over Iroh or HyperDHT any more ("Native endpoint limit reached"). The app now stops them the moment the window's page starts again, and each contact hears the close at once.
