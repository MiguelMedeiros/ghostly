import { GROUP_FILE_LIMITS } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { formatFileSize } from "../../lib/format";
import { setGroupDownloads, useGroupDownloads, wifiKnown, type GroupDownloads } from "../../lib/groupDownloads";
import { Row } from "../layout";
import { Select } from "../ui/Select";

/**
 * Data & storage → Download automatically in groups (WISP 503): off, Wi-Fi only (where this browser says what the
 * connection is), or always. Each member's device decides for itself; nothing is sent.
 */
export function GroupDownloadsRow() {
  const { t } = useI18n();
  const mode = useGroupDownloads();
  // Chosen on a browser that said, and kept while this one does not: still shown, so the choice reads as it is.
  const modes: GroupDownloads[] = wifiKnown() || mode === "wifi" ? ["off", "wifi", "always"] : ["off", "always"];
  const label = t("settings.groupDownloads.title");
  return (
    <Row label={label} testId="settings-group-downloads-row" hint={t("settings.groupDownloads.hint")}
      info={t("settings.groupDownloads.info", { file: formatFileSize(GROUP_FILE_LIMITS.autoBytes), group: formatFileSize(GROUP_FILE_LIMITS.autoBytesPerGroup) })}>
      <Select fit aria-label={label} data-testid="settings-group-downloads" value={mode} onChange={(value) => void setGroupDownloads(value).catch(() => {})}
        options={modes.map((value) => ({ value, label: t(`settings.groupDownloads.${value}` as const) }))} />
    </Row>
  );
}
