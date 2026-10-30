import { UpdateBanner } from "./UpdateBanner";
import { OfflineBanner } from "./OfflineBanner";
import { StorageFullBanner } from "./StorageFullBanner";
import { LimitedBanner } from "./devices/LimitedStart";

/**
 * What the app has to say about itself, above the chat list. The list folded to a rail (ChatRail.tsx) has no room for
 * these lines, so there they go over the open page (App.tsx): nothing going out, or a version to install, still shows.
 */
export function ListNotices() {
  return (
    <>
      <UpdateBanner />
      <OfflineBanner />
      <StorageFullBanner />
      <LimitedBanner />
    </>
  );
}
