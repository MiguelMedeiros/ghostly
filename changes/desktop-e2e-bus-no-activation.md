---
section: For developers / Tests
---
- The D-Bus session bus each Linux Desktop end-to-end app gets starts only xdg-desktop-portal and its permission store, which WebKitGTK needs to show a call's picture. It read the system's session configuration, so on a Linux desktop the app's first call into the portal started a whole set of portals and backends on the person's live Wayland session, one set per test, and on Hyprland xdg-desktop-portal-hyprland crashed as each bus went away (a crash notice per test).
