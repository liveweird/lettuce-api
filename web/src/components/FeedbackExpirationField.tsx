import { Select } from "@mantine/core";
import { useTranslation } from "react-i18next";
import DateField from "./DateField";
import { addIsoDays, todayIsoDate } from "../utils/datetime";
import { EXPIRATION_PRESETS, type ExpirationPreset } from "../utils/feedbackForm";

/**
 * The requester's optional expiration control (v3.8.0 — RequestFeedback and its sibling
 * AskFeedback): a preset `Select` (none/1 week/2 weeks/30 days/pick a date) that reveals a
 * `DateField` only for the custom pick, `minIso` pinned to tomorrow. `resolveFeedbackExpiresOn`
 * (`utils/feedbackForm.ts`) turns the pair into the ISO `expiresOn` the create payload sends.
 */
export default function FeedbackExpirationField({
  preset,
  onPresetChange,
  customDate,
  onCustomDateChange,
}: {
  preset: ExpirationPreset;
  onPresetChange: (preset: ExpirationPreset) => void;
  customDate: string;
  onCustomDateChange: (iso: string) => void;
}) {
  const { t } = useTranslation();
  const options = EXPIRATION_PRESETS.map((value) => ({
    value,
    label: t(`feedback.expiration.option.${value}`),
  }));
  return (
    <>
      <Select
        label={t("feedback.expiration.label")}
        data={options}
        allowDeselect={false}
        value={preset}
        onChange={(v) => v && onPresetChange(v as ExpirationPreset)}
      />
      {preset === "custom" && (
        <DateField
          label={t("feedback.expiration.dateLabel")}
          value={customDate}
          onChange={onCustomDateChange}
          minIso={addIsoDays(todayIsoDate(), 1)}
        />
      )}
    </>
  );
}
