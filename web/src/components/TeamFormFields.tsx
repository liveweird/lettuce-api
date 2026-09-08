import { CloseButton, Select, TextInput } from "@mantine/core";
import { type UseFormReturnType } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { isAdmin } from "../api/session";
import { useManagerOptions } from "../hooks/useManagerOptions";
import { charCountDescription } from "../utils/charCount";
import { MAX_TEAM_NAME_LENGTH, type TeamFormValues } from "../utils/teamForm";
import { renderUserOption } from "./userOptions";

/**
 * The field block shared by the create and edit team pages (which own submit/error handling).
 * Owns the manager picker's option pool too — both pages fetched it identically.
 */
export default function TeamFormFields({ form }: { form: UseFormReturnType<TeamFormValues> }) {
  const { t } = useTranslation();
  const { managerOptions, managersLoading, managersError } = useManagerOptions(isAdmin());
  return (
    <>
      <TextInput
        label={t("common.field.name")}
        autoFocus
        maxLength={MAX_TEAM_NAME_LENGTH}
        description={charCountDescription(form.values.name.length, MAX_TEAM_NAME_LENGTH)}
        rightSection={
          form.values.name ? (
            <CloseButton
              size="sm"
              aria-label={t("teams.clearName")}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => form.setFieldValue("name", "")}
            />
          ) : null
        }
        rightSectionPointerEvents="auto"
        {...form.getInputProps("name")}
      />
      <Select
        label={t("common.field.manager")}
        placeholder={managersLoading ? t("common.state.loading") : t("teams.pickManager")}
        data={managerOptions}
        renderOption={renderUserOption}
        searchable
        clearable={false}
        disabled={managersLoading}
        nothingFoundMessage={t("teams.noMatchingUsers")}
        {...form.getInputProps("managerId")}
        // A failed pool load must not look like an empty org (after the form error, which wins).
        error={form.getInputProps("managerId").error ?? (managersError ? t("common.error.optionsFailed") : undefined)}
      />
    </>
  );
}
