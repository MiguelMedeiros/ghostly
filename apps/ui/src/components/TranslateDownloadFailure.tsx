import { useTranslateDownloadFailure } from "../hooks/useTranslateDownload";

/** A download that failed after its question was closed, or its page left: the question again, wherever the app is. */
export function TranslateDownloadFailure() {
  return useTranslateDownloadFailure();
}
