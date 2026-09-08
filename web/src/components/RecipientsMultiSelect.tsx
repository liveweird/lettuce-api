import { useState } from "react";
import { MultiSelect } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { accessibleRenderPill } from "./accessiblePill";
import { renderUserOption, type UserOption } from "./userOptions";

// A feedback may address up to four people (v3.1.0) — mirrors the server's MAX_FEEDBACK_SUBJECTS.
const MAX_FEEDBACK_RECIPIENTS = 4;
const FIELD_ID = "feedback-recipients";

/**
 * The recipient picker of the feedback/kudo create screens' picker mode (v3.1.0): a searchable
 * MultiSelect over the caller's user pool capped at MAX_FEEDBACK_RECIPIENTS, selection order
 * preserved — the first pick is the feedback's anchor subject. Mantine's `maxValues` makes a
 * pick beyond the cap a SILENT no-op (the options stay listed), so the cap is surfaced through
 * `onMaxValues`: the description flips to the "maximum reached" wording until a pill is removed.
 * Filtering is theme-owned (accent-insensitive); pills carry a named remove button (no
 * `clearable` — Mantine's clear button is aria-hidden, and per-pill removal covers it); the
 * description/error are wired to the combobox field itself, since Mantine only describes the
 * PillsInput root. `value` holds user ids as strings (the MultiSelect contract).
 */
export default function RecipientsMultiSelect({
  label,
  options,
  value,
  onChange,
  error,
}: {
  label: string;
  options: UserOption[];
  value: string[];
  onChange: (value: string[]) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const [capHit, setCapHit] = useState(false);
  const atCap = value.length >= MAX_FEEDBACK_RECIPIENTS;
  const description =
    capHit && atCap
      ? t("feedback.recipientsMaxReached", { max: MAX_FEEDBACK_RECIPIENTS })
      : t("feedback.recipientsHint", { max: MAX_FEEDBACK_RECIPIENTS });
  return (
    <MultiSelect
      id={FIELD_ID}
      label={label}
      description={description}
      placeholder={value.length === 0 ? t("feedback.pickUser") : undefined}
      data={options}
      renderOption={renderUserOption}
      value={value}
      onChange={(next) => {
        if (next.length < MAX_FEEDBACK_RECIPIENTS) setCapHit(false);
        onChange(next);
      }}
      maxValues={MAX_FEEDBACK_RECIPIENTS}
      onMaxValues={() => setCapHit(true)}
      searchable
      hidePickedOptions
      nothingFoundMessage={t("feedback.noUsersAvailable")}
      error={error}
      renderPill={accessibleRenderPill((name) => t("feedback.removeRecipient", { name }))}
      aria-describedby={`${FIELD_ID}-description${error ? ` ${FIELD_ID}-error` : ""}`}
      w={{ base: "100%", sm: 360 }}
    />
  );
}
