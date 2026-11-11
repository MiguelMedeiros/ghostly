import { UpdateBanner } from "./UpdateBanner";
import { OfflineBanner } from "./OfflineBanner";
import { ReconnectingBanner } from "./ReconnectingBanner";
import { StorageFullBanner } from "./StorageFullBanner";
import { LimitedBanner } from "./devices/LimitedStart";
import { StoppedInBackgroundBanner } from "./StoppedInBackgroundBanner";

/**
 * What the app has to say about itself, above the chat list. The list folded to a rail (ChatRail.tsx) has no room for
 * these lines, so there they go over the open page (App.tsx): nothing going out, or a version to install, still shows.
 */
export function ListNotices() {
  return (
    <>
      <UpdateBanner />
      <OfflineBanner />
      <ReconnectingBanner />
      <StorageFullBanner />
      <LimitedBanner />
      <StoppedInBackgroundBanner />
    </>
  );
}
