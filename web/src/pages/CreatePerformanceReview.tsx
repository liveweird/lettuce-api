import { useMemo, useState } from "react";
import { Link as RouterLink, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Anchor, Button, Container, Paper, Select, Stack, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { hasFeature } from "../api/session";
import { toReportOptions, useManagedReports } from "../hooks/useManagedReports";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import { createPerformanceReview } from "../api/reviews";
import DiscardGuard from "../components/DiscardGuard";
import FormFooter from "../components/FormFooter";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import PersonaChip from "../components/PersonaChip";
import { renderUserOption } from "../components/userOptions";
import { renderPeriodOption, useReviewPeriodOptions } from "../hooks/useReviewPeriodOptions";
import { reviewEditLink, reviewViewLink } from "../utils/performanceReviewLinks";
import { showSuccessToast } from "../utils/toast";
import { reviewSaveErrorMessage } from "../utils/reviewRatings";
import { safeBackParam } from "../utils/url";

const BACK_TO = "/performance?tab=managed";
// The occupied-slot 409 carries the existing review's API path in ProblemDetail.instance —
// surface it as a link so the manager lands on the record instead of hunting for it.
function conflictReviewId(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const match = err.instance?.match(/\/performance-reviews\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Deliberately minimal (the CreateOneOnOne idiom): pick the direct report (skipped when a card
 * prefilled it) and the period, create the empty DRAFT, and land straight in the editor where
 * the four assessments are filled in. A subordinate has at most one review per period — an
 * occupied slot is a 409 with a link to the existing review.
 */
export default function CreatePerformanceReview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const preselectedId = Number(searchParams.get("subordinateId"));
  const preselected = Number.isFinite(preselectedId) && preselectedId > 0;
  const backTo = safeBackParam(searchParams) ?? BACK_TO;

  const [picked, setPicked] = useState<string | null>(null);
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictId, setConflictId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The one cancel guard (v3.5.0): the two picks are the only work this screen holds, so a
  // fresh form leaves straight away and only an explicit pick asks.
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: picked != null || periodId != null,
    to: backTo,
    title: t("performanceReview.discardTitle"),
    message: t("performanceReview.discardMessage"),
  });

  // The pool ALWAYS loads (v2.35.0): a prefilled subordinate resolves its display name
  // against the caller's own managed data — never a URL param — and an id outside the
  // caller's chain falls back to the picker once the pool settles.
  const { reports, reportsError, reportsReady } = useManagedReports(true);
  const options = toReportOptions(reports);
  const preselectedReport = preselected
    ? reports.find((r) => r.userId === preselectedId)
    : undefined;
  const showPicker = !preselected || (reportsReady && !preselectedReport);
  const subordinateId =
    preselectedReport?.userId ?? (showPicker && picked != null ? Number(picked) : null);

  // Newest first. A not-yet-started period is not assessable (the server 400s it), so its
  // option renders disabled and the default is the newest STARTED period — usually the
  // currently-running one. With every period still in the future there is no valid choice:
  // effectivePeriod stays null, which keeps Create disabled (the alert below explains).
  const { periods, options: rawPeriodOptions } = useReviewPeriodOptions();
  const periodOptions = useMemo(
    () => rawPeriodOptions.map((o) => ({ ...o, disabled: o.future === true })),
    [rawPeriodOptions],
  );
  const effectivePeriod = periodId ?? periodOptions.find((o) => !o.disabled)?.value ?? null;
  const allPeriodsFuture = periodOptions.length > 0 && periodOptions.every((o) => o.disabled);

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("PERFORMANCE_REVIEWS")) return <Navigate to="/" replace />;

  async function save() {
    if (!subordinateId || !effectivePeriod) return;
    setSubmitting(true);
    setError(null);
    setConflictId(null);
    try {
      const created = await createPerformanceReview({
        subordinateId,
        periodId: Number(effectivePeriod),
      });
      await queryClient.invalidateQueries({ queryKey: ["performanceReviews"] });
      showSuccessToast(t("performanceReview.toast.created"));
      // Straight into the editor — the DRAFT is empty and waiting for its assessments.
      navigate(reviewEditLink(created.id, undefined, backTo), { replace: true });
    } catch (err) {
      setConflictId(conflictReviewId(err));
      setError(
        err instanceof ApiError && err.status === 409
          ? t("performanceReview.error.duplicate")
          : reviewSaveErrorMessage(err, t),
      );
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t("performanceReview.newReview")}
        description={t("performanceReview.createHint")}
        mb="lg"
      />
      <Container size="md" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          <Stack gap="md">
            {/* The context line (v3.5.0): the pair and the period — the pickers keep their
                names via aria-label (the "Team member" / "Period" comboboxes). */}
            <MetaStrip
              items={[
                {
                  key: "manager",
                  label: t("performanceReview.manager"),
                  value: <Text size="sm">{t("common.state.you")}</Text>,
                },
                {
                  key: "subordinate",
                  label: t("performanceReview.subordinate"),
                  value: showPicker ? (
                    <Select
                      aria-label={t("performanceReview.subordinate")}
                      placeholder={t("performanceReview.pickSubordinate")}
                      data={options}
                      renderOption={renderUserOption}
                      value={picked}
                      onChange={setPicked}
                      searchable
                      clearable
                      nothingFoundMessage={t("performanceReview.noReports")}
                      error={reportsError ? t("common.error.optionsFailed") : undefined}
                      w={260}
                    />
                  ) : (
                    // The `#id` placeholder shows only until the pool resolves the canonical name.
                    <PersonaChip name={preselectedReport?.name ?? `#${preselectedId}`} />
                  ),
                },
                {
                  key: "period",
                  label: t("performanceReview.period"),
                  value: (
                    <Select
                      aria-label={t("performanceReview.period")}
                      data={periodOptions}
                      value={effectivePeriod}
                      onChange={setPeriodId}
                      allowDeselect={false}
                      renderOption={renderPeriodOption}
                      w={260}
                    />
                  ),
                },
              ]}
            />

            {periods != null && periods.length === 0 && (
              <Alert color="orange" variant="light">
                {t("performanceReview.noPeriods")}
              </Alert>
            )}
            {allPeriodsFuture && (
              <Alert color="orange" variant="light">
                {t("performanceReview.noStartedPeriods")}
              </Alert>
            )}
            {error && (
              <Alert color="red" variant="light">
                <Stack gap={4}>
                  <Text size="sm">{error}</Text>
                  {conflictId != null && (
                    <Anchor component={RouterLink} to={reviewViewLink(conflictId, undefined, backTo)} size="sm">
                      {t("performanceReview.openExisting")}
                    </Anchor>
                  )}
                </Stack>
              </Alert>
            )}

            <FormFooter>
              <Button type="button" variant="default" onClick={requestCancel} disabled={submitting}>
                {t("common.action.cancel")}
              </Button>
              <Button
                onClick={() => void save()}
                loading={submitting}
                disabled={!subordinateId || !effectivePeriod}
              >
                {t("common.action.create")}
              </Button>
            </FormFooter>
          </Stack>
        </Paper>
      </Container>

      <DiscardGuard {...guardProps} />
    </>
  );
}
