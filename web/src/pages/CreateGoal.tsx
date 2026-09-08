import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Container, Paper, Select, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { hasFeature } from "../api/session";
import { activateGoal, createGoal } from "../api/goals";
import DiscardGuard from "../components/DiscardGuard";
import CreateActivateModals from "../components/CreateActivateModals";
import FormFooter from "../components/FormFooter";
import GoalDefinitionFields from "../components/GoalDefinitionFields";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import PersonaChip from "../components/PersonaChip";
import { renderUserOption } from "../components/userOptions";
import { toReportOptions, useManagedReports } from "../hooks/useManagedReports";
import { useCreateThenActivate } from "../hooks/useCreateThenActivate";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import {
  goalDefinitionValidation,
  toDefinitionBody,
  type GoalDefinitionFormValues,
} from "../utils/goalForm";
import { invalidateGoal } from "../utils/goalQueries";
import { safeBackParam } from "../utils/url";

// Default cancel target when no `back` param is present: the subordinates grid, the only
// entry point that links here today.
const BACK_TO = "/?tab=subordinates";
const INITIAL_VALUES: GoalDefinitionFormValues = {
  title: "",
  description: "",
  type: "NUMBER",
  targetValue: "",
  targetDirection: "AT_LEAST",
  milestones: [],
  dueDate: "",
};
/**
 * The manager's goal-create screen: pick (or arrive with) a direct report, define the goal —
 * the same definition fields the DRAFT editor offers — and Create. The lifecycle (DRAFT
 * lands, activate prompt, error handling) is the shared `useCreateThenActivate` flow.
 */
export default function CreateGoal() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();

  const preselectedId = Number(searchParams.get("subordinateId"));
  const preselected = Number.isFinite(preselectedId) && preselectedId > 0;
  const backTo = safeBackParam(searchParams) ?? BACK_TO;

  const [picked, setPicked] = useState<string | null>(null);
  const flow = useCreateThenActivate({
    area: "goal",
    backTo,
    activate: activateGoal,
    invalidate: invalidateGoal,
  });

  const form = useForm<GoalDefinitionFormValues>({
    initialValues: INITIAL_VALUES,
    validate: goalDefinitionValidation(t),
  });
  // The one cancel guard (v3.5.0). Dirtiness is a payload compare, not `form.isDirty()` —
  // the milestone list's insert/remove/reorder operations don't flip Mantine's dirty flags.
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: () =>
      picked != null ||
      JSON.stringify(toDefinitionBody(form.values)) !== JSON.stringify(toDefinitionBody(INITIAL_VALUES)),
    to: backTo,
    title: t("goal.discardTitle"),
    message: t("goal.discardMessage"),
  });

  // The pool ALWAYS loads (v2.35.0): a prefilled subordinate (card/list flows) resolves its
  // display name against the caller's own managed data — never a URL param — and an id
  // outside the caller's chain falls back to the picker once the pool settles.
  const { reports, reportsError, reportsReady } = useManagedReports(true);
  const options = toReportOptions(reports);
  const preselectedReport = preselected
    ? reports.find((r) => r.userId === preselectedId)
    : undefined;
  const showPicker = !preselected || (reportsReady && !preselectedReport);
  const subordinateId =
    preselectedReport?.userId ?? (showPicker && picked != null ? Number(picked) : null);

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("GOALS")) return <Navigate to="/" replace />;

  async function save(values: GoalDefinitionFormValues) {
    if (!subordinateId) return;
    await flow.submitCreate(() =>
      createGoal({
        subordinateId,
        ...toDefinitionBody(values),
      }),
    );
  }

  return (
    <>
      <PageHeader title={t("goal.createTitle")} description={t("goal.createHint")} mb="lg" />
      <Container size="md" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          <form onSubmit={form.onSubmit(save)} noValidate>
            <Stack>
              {/* The context line (v3.5.0): the pair — the picker keeps its name via aria-label. */}
              <MetaStrip
                items={[
                  {
                    key: "manager",
                    label: t("goal.manager"),
                    value: <Text size="sm">{t("common.state.you")}</Text>,
                  },
                  {
                    key: "subordinate",
                    label: t("goal.subordinate"),
                    value: showPicker ? (
                      <Select
                        aria-label={t("goal.subordinate")}
                        placeholder={t("goal.pickSubordinate")}
                        data={options}
                        renderOption={renderUserOption}
                        value={picked}
                        onChange={setPicked}
                        searchable
                        clearable
                        nothingFoundMessage={t("goal.noReports")}
                        error={reportsError ? t("common.error.optionsFailed") : undefined}
                        w={260}
                      />
                    ) : (
                      // The `#id` placeholder shows only until the pool resolves the canonical name.
                      <PersonaChip name={preselectedReport?.name ?? `#${preselectedId}`} />
                    ),
                  },
                ]}
              />

              <GoalDefinitionFields form={form} />

              {flow.error && (
                <Alert color="red" variant="light">
                  {flow.error}
                </Alert>
              )}

              <FormFooter>
                <Button type="button" variant="default" onClick={requestCancel} disabled={flow.submitting}>
                  {t("common.action.cancel")}
                </Button>
                <Button
                  type="submit"
                  loading={flow.submitting}
                  disabled={!subordinateId || flow.createdId != null}
                >
                  {t("common.action.create")}
                </Button>
              </FormFooter>
            </Stack>
          </form>
        </Paper>
      </Container>

      <DiscardGuard {...guardProps} />
      <CreateActivateModals
        area="goal"
        createdId={flow.createdId}
        promptClosed={flow.promptClosed}
        activating={flow.activating}
        onFinishAsDraft={flow.finishAsDraft}
        onActivate={flow.activateNow}
      />
    </>
  );
}
