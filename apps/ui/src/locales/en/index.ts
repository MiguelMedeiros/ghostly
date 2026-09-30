// English, the source language: one file per area of the app, apps/ui/src/locales/en/<area>.json. Imported one by one
// (alphabetical, one per line) so that `t()` keys are type-checked against it. A new area is a new file plus
// its two lines here; the other languages are found by apps/ui/src/locales/index.ts without a list.
import app from "./app.json";
import calls from "./calls.json";
import cards from "./cards.json";
import chat from "./chat.json";
import common from "./common.json";
import composer from "./composer.json";
import connection from "./connection.json";
import errors from "./errors.json";
import group from "./group.json";
import home from "./home.json";
import identities from "./identities.json";
import invite from "./invite.json";
import join from "./join.json";
import lockScreen from "./lockScreen.json";
import mentions from "./mentions.json";
import mute from "./mute.json";
import network from "./network.json";
import pairing from "./pairing.json";
import payments from "./payments.json";
import profile from "./profile.json";
import profilePeek from "./profilePeek.json";
import profileSwitcher from "./profileSwitcher.json";
import pwa from "./pwa.json";
import secretGuard from "./secretGuard.json";
import services from "./services.json";
import settings from "./settings.json";
import share from "./share.json";
import sidebar from "./sidebar.json";
import tabs from "./tabs.json";
import updates from "./updates.json";
import wallet from "./wallet.json";

export default {
  app,
  calls,
  cards,
  chat,
  common,
  composer,
  connection,
  errors,
  group,
  home,
  identities,
  invite,
  join,
  lockScreen,
  mentions,
  mute,
  network,
  pairing,
  payments,
  profile,
  profilePeek,
  profileSwitcher,
  pwa,
  secretGuard,
  services,
  settings,
  share,
  sidebar,
  tabs,
  updates,
  wallet,
};
