import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Container, Paper, Select, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { hasFeature } from "../api/session";
import { createSuccessionPlan } from "../api/successionPlans";
import DiscardGuard from "../components/DiscardGuard";
import FormFooter from "../components/FormFooter";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import SuccessionPlanFields from "../components/SuccessionPlanFields";
import { renderUserOption } from "../components/userOptions";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import { toReportOptions, useManagedReports } from "../hooks/useManagedReports";
import {
  emptySuccessionPlanValues,
  successionPlanValidation,
  successionSaveErrorMessage,
  toSuccessionPlanBody,
  type SuccessionPlanFormValues,
} from "../utils/successionForm";
import { successionPlanViewLink } from "../utils/successionLinks";
import { invalidateSuccession } from "../utils/successionQueries";
import { showSuccessToast } from "../utils/toast";
import { safeBackParam } from "../utils/url";

/**
 * The plan-create screen: pick a report from the caller's transitive chain (the server
 * enforces the same rule), set the planning labels + bench depth, list the loss impact, and
 * Create — the plan starts OPEN with an empty bench (successors are nominated from the view
 * screen). At most one open plan per (owner, person): a duplicate lands as the 409 wording.
 */
export default function CreateSuccessionPlan() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const backTo = safeBackParam(searchParams) ?? "/succession";

  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<SuccessionPlanFormValues>({
    initialValues: emptySuccessionPlanValues(),
    validate: successionPlanValidation(t),
  });
  // The person pick lives outside the form, so it joins the dirtiness by hand.
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: () => picked != null || form.isDirty(),
    to: backTo,
    title: t("succession.discardCreateTitle"),
    message: t("succession.discardCreateMessage"),
  });

  const { reports, reportsError } = useManagedReports(true);
  const options = toReportOptions(reports);

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("SUCCESSION_PLANS")) return <Navigate to="/" replace />;

  const userId = picked != null ? Number(picked) : null;

  async function save(values: SuccessionPlanFormValues) {
    if (!userId) return;
    setError(null);
    setSubmitting(true);
    try {
      const created = await createSuccessionPlan({ userId, ...toSuccessionPlanBody(values) });
      await invalidateSuccession(queryClient);
      showSuccessToast(t("succession.toast.created"));
      // Land on the new plan — nominating successors is the natural next step.
      navigate(successionPlanViewLink(created.id), { replace: true });
    } catch (err) {
      setError(successionSaveErrorMessage(err, t));
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title={t("succession.createTitle")} description={t("succession.createHint")} mb="lg" />
      <Container size="md" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          <form onSubmit={form.onSubmit(save)} noValidate>
            <Stack>
              {/* The parties line (v3.5.0): the fixed owner and the seat picker, which keeps
                  its accessible name via aria-label — the strip's <dt> is the visible label. */}
              <MetaStrip
                items={[
                  {
                    key: "owner",
                    label: t("succession.owner"),
                    value: <Text size="sm">{t("common.state.you")}</Text>,
                  },
                  {
                    key: "person",
                    label: t("succession.person"),
                    value: (
                      <Select
                        aria-label={t("succession.person")}
                        placeholder={t("succession.pickPerson")}
                        data={options}
                        renderOption={renderUserOption}
                        value={picked}
                        onChange={setPicked}
                        searchable
                        clearable
                        nothingFoundMessage={t("succession.noReports")}
                        error={reportsError ? t("common.error.optionsFailed") : undefined}
                        w={280}
                      />
                    ),
                  },
                ]}
              />

              <SuccessionPlanFields form={form} />

              {error && (
                <Alert color="red" variant="light">
                  {error}
                </Alert>
              )}

              <FormFooter>
                <Button type="button" variant="default" onClick={requestCancel} disabled={submitting}>
                  {t("common.action.cancel")}
                </Button>
                <Button type="submit" loading={submitting} disabled={!userId}>
                  {t("common.action.create")}
                </Button>
              </FormFooter>
            </Stack>
          </form>
        </Paper>
      </Container>

      <DiscardGuard {...guardProps} />
    </>
  );
}
