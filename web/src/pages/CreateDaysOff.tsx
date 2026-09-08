import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Container,
  Group,
  Paper,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import DiscardGuard from "../components/DiscardGuard";
import DateField from "../components/DateField";
import FormFooter from "../components/FormFooter";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import { renderUserOption } from "../components/userOptions";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import { ApiError } from "../api/http";
import { getUserId, hasFeature } from "../api/session";
import {
  createDaysOff,
  listDaysOffBudgets,
  listPublicHolidays,
  type DaysOffBudget,
  type DaysOffType,
} from "../api/daysoff";
import { isValidIsoDate, todayIsoDate } from "../utils/datetime";
import { costHalfDays, formatDays } from "../utils/daysOffCost";
import { daysOffListLink } from "../utils/daysOffLinks";
import { toReportOptions, useManagedReports } from "../hooks/useManagedReports";
import { invalidateDaysOff } from "../utils/daysOffQueries";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import { safeBackParam } from "../utils/url";

// The picker's UNPAID sentinel; every other option value is a paid pool kind's id (v3.2.0).
const UNPAID_PICK = "UNPAID";

// The pool picker's derived state (v3.2.0): the person's non-archived pool rows (the default
// first), the effective pick (null = the default pool), the resulting type, and the picked
// row backing the budget preview.
function resolvePoolPick(
  rows: DaysOffBudget[] | undefined,
  onBehalf: boolean,
  subjectId: number | null,
  pick: string | null,
): { pools: DaysOffBudget[]; pickValue: string | null; type: DaysOffType; budget: DaysOffBudget | undefined } {
  // On behalf, no pools until a report is picked (the managed rows span every report).
  const pools = onBehalf && subjectId == null
    ? []
    : (rows ?? []).filter((b) => (subjectId == null || b.userId === subjectId) && !b.poolArchived);
  const defaultPool = pools.find((b) => b.isDefault);
  const pickValue = pick ?? (defaultPool ? String(defaultPool.poolTypeId) : null);
  const type: DaysOffType = pickValue === UNPAID_PICK ? "UNPAID" : "PAID";
  const budget = type === "PAID" ? pools.find((b) => String(b.poolTypeId) === pickValue) : undefined;
  return { pools, pickValue, type, budget };
}

// The discard guard's dirtiness (v3.5.0): hand-rolled state, so a compare against the fresh
// form — any pick, any half-day tick, or either date moved off today.
function isDraftDirty(draft: {
  pick: string | null;
  subjectPick: string | null;
  startHalf: boolean;
  endHalf: boolean;
  startDate: string;
  endDate: string;
}): boolean {
  const today = todayIsoDate();
  return (
    draft.pick != null ||
    draft.subjectPick != null ||
    draft.startHalf ||
    draft.endHalf ||
    draft.startDate !== today ||
    draft.endDate !== today
  );
}

/**
 * The create-request form: one consecutive period, optional half-day edges, and the pool —
 * one of the person's paid pools (v3.2.0 — budgeted; the default pool pre-picked) or UNPAID.
 * The cost preview mirrors the server's working-day math over the live holiday registry; a
 * PAID request that would not fit the picked pool's remaining budget is blocked client-side
 * (the server enforces the same rule with a 409).
 *
 * With `?onBehalf=1` (v2.29.0, the CreateFeedback picker-mode precedent — no separate route)
 * the same form becomes the manager-side recording screen: a report picker over the caller's
 * whole transitive subtree (the chain rule, v2.33.0), the budget preview reading the PICKED
 * report's managed-budget row, and a "Submit auto-accepted" submit —
 * the entry is born ACCEPTED with the caller as resolver (the vacation-history population flow).
 */
export default function CreateDaysOff() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const onBehalf = searchParams.get("onBehalf") === "1";
  // The shared sanitizer (v2.35.0) — the local startsWith("/") check it replaces still
  // admitted protocol-relative "//evil.example" values.
  const backTo = safeBackParam(searchParams) ?? daysOffListLink(onBehalf ? "team" : "requests");

  // null = the default pool (resolved from the budget rows once they arrive).
  const [pick, setPick] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(todayIsoDate());
  const [endDate, setEndDate] = useState(todayIsoDate());
  const [startHalf, setStartHalf] = useState(false);
  const [endHalf, setEndHalf] = useState(false);
  const [subjectPick, setSubjectPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const subjectId = onBehalf && subjectPick != null ? Number(subjectPick) : null;
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: isDraftDirty({ pick, subjectPick, startHalf, endHalf, startDate, endDate }),
    to: backTo,
  });

  // On-behalf mode's picker pool: the caller's whole subtree (chain-wide since v2.33.0),
  // minus the caller — a manager on their own roster is 403'd server-side (nobody records
  // on their own behalf).
  const { reports, reportsError } = useManagedReports(onBehalf);
  const reportOptions = toReportOptions(reports.filter((p) => p.userId !== getUserId()));

  const holidaysQuery = useQuery({
    queryKey: ["publicHolidays"],
    queryFn: listPublicHolidays,
  });
  const year = Number(startDate.slice(0, 4)) || new Date().getFullYear();
  // The budget preview follows the mode: the caller's own row, or — on behalf — the PICKED
  // report's row out of the managed-budgets view (the UserDaysOff client-side-filter idiom).
  // On behalf the fetch runs in chain mode so a subtree pick still finds its row (v2.33.0).
  const budgetView = onBehalf ? "managed" : "own";
  const budgetQuery = useQuery({
    queryKey: onBehalf
      ? ["daysOffBudgets", budgetView, "indirect", year]
      : ["daysOffBudgets", budgetView, year],
    queryFn: () => listDaysOffBudgets(budgetView, year, onBehalf ? { includeIndirect: true } : undefined),
    // Only a complete, real start date fetches (v3.5.2) — a cleared or half-typed date must
    // never fire a request keyed on a fragment year or silently fall back to this year.
    enabled: isValidIsoDate(startDate),
    // A year change re-keys the query; keeping the previous rows means the picked pool never
    // blinks out (and a submit never silently loses its poolTypeId) mid-refetch (v3.2.1).
    placeholderData: keepPreviousData,
  });
  // The person's pool rows (v3.2.0): the default first; archived history never offered.
  const { pools, pickValue, type, budget } = resolvePoolPick(budgetQuery.data, onBehalf, subjectId, pick);
  const poolOptions = [
    ...pools.map((b) => ({ value: String(b.poolTypeId), label: b.poolName })),
    { value: UNPAID_PICK, label: t("daysOff.type.UNPAID") },
  ];

  const singleDay = startDate === endDate;
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4);
  const ordered = startDate <= endDate;
  const holidays = new Set((holidaysQuery.data ?? []).map((h) => h.date));
  const costH =
    ordered && sameYear
      ? costHalfDays(startDate, endDate, startHalf, singleDay ? false : endHalf, holidays)
      : null;
  const costDays = costH != null ? costH / 2 : null;
  const overBudget =
    type === "PAID" && costDays != null && budget != null && costDays > budget.remaining;
  const zeroCost = costH === 0;
  // A PAID submit needs its pool row resolved (v3.2.1): with no rows yet — loading, a failed
  // load, or no report picked — nothing is bookable except an explicit Unpaid.
  const poolResolved = type === "UNPAID" || budget != null;
  const submittable =
    ordered && sameYear && costH != null && costH > 0 && !overBudget && !submitting && poolResolved &&
    (!onBehalf || subjectId != null);

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("DAYS_OFF")) return <Navigate to="/" replace />;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await createDaysOff({
        type,
        ...(type === "PAID" && budget ? { poolTypeId: budget.poolTypeId } : {}),
        startDate,
        endDate,
        startHalf,
        endHalf: singleDay ? false : endHalf,
        ...(subjectId != null ? { userId: subjectId } : {}),
      });
      await invalidateDaysOff(queryClient);
      showSuccessToast(t(onBehalf ? "daysOff.toast.recorded" : "daysOff.toast.requested"));
      navigate(backTo, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The overlap 409 carries the conflicting request in ProblemDetail.instance; the
        // budget 409 does not — distinct messages, no detail page to link to. On-behalf
        // wording points at the report's requests/budget, not "yours".
        setError(
          t(
            err.instance
              ? onBehalf ? "daysOff.error.overlapOnBehalf" : "daysOff.error.overlap"
              : onBehalf ? "daysOff.error.overBudgetOnBehalf" : "daysOff.error.overBudget",
          ),
        );
      } else {
        setError(
          saveErrorMessage(err, t, {
            invalid: "daysOff.error.invalid",
            failedStatus: "daysOff.error.saveFailedStatus",
            failed: "daysOff.error.saveFailed",
          }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t(onBehalf ? "daysOff.recordTitle" : "daysOff.createTitle")}
        description={t(onBehalf ? "daysOff.recordHint" : "daysOff.createHint")}
        mb="lg"
      />
      <Container size="sm" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          <Stack gap="md">
            {/* The on-behalf context line (v3.5.0): the report picker keeps its accessible
                name via aria-label — the strip's <dt> is the visible label. */}
            {onBehalf && (
              <MetaStrip
                items={[
                  {
                    key: "onBehalf",
                    label: t("daysOff.onBehalfLabel"),
                    value: (
                      <Select
                        aria-label={t("daysOff.onBehalfLabel")}
                        placeholder={t("daysOff.pickReport")}
                        data={reportOptions}
                        renderOption={renderUserOption}
                        value={subjectPick}
                        onChange={(v) => {
                          setSubjectPick(v);
                          // A new person, their own pools — back to their default.
                          setPick(null);
                        }}
                        searchable
                        clearable
                        nothingFoundMessage={t("daysOff.budget.noReports")}
                        error={reportsError ? t("common.error.optionsFailed") : undefined}
                        w={320}
                      />
                    ),
                  },
                ]}
              />
            )}

            {/* The pool picker (v3.2.0): the person's paid pools + Unpaid; "Type" stays the
                label — the answer is still "which kind of days off". */}
            <Select
              label={t("daysOff.type.label")}
              data={poolOptions}
              value={pickValue}
              placeholder={t(onBehalf && subjectId == null ? "daysOff.pickReport" : "daysOff.pool.loadingPools")}
              onChange={(v) => v && setPick(v)}
              allowDeselect={false}
              w={260}
            />

            <Group align="flex-end" gap="md" wrap="wrap">
              <DateField
                label={t("daysOff.column.startDate")}
                value={startDate}
                onChange={(iso) => {
                  const v = iso;
                  setStartDate(v);
                  // Keep the range ordered as the user moves the start forward.
                  if (v > endDate) setEndDate(v);
                }}
                w={180}
              />
              <DateField
                label={t("daysOff.column.endDate")}
                value={endDate}
                minIso={startDate}
                onChange={(iso) => setEndDate(iso)}
                w={180}
              />
            </Group>
            <Group gap="xl">
              <Checkbox
                label={t("daysOff.startHalfLabel")}
                checked={startHalf}
                onChange={(e) => setStartHalf(e.currentTarget.checked)}
              />
              <Checkbox
                label={t("daysOff.endHalfLabel")}
                checked={singleDay ? false : endHalf}
                onChange={(e) => setEndHalf(e.currentTarget.checked)}
                disabled={singleDay}
              />
            </Group>

            {!ordered && (
              <Alert color="red" variant="light">
                {t("daysOff.validation.order")}
              </Alert>
            )}
            {ordered && !sameYear && (
              <Alert color="red" variant="light">
                {t("daysOff.validation.sameYear")}
              </Alert>
            )}
            {zeroCost && (
              <Alert color="orange" variant="light">
                {t("daysOff.validation.zeroCost")}
              </Alert>
            )}

            {/* The live preview: the request's working-day cost and, for PAID, what remains. */}
            {costDays != null && costDays > 0 && (
              <Paper withBorder p="sm" radius="md">
                <Stack gap={2}>
                  <Text size="sm" fw={600}>
                    {/* count drives the plural form (PL: dzień/dni robocze/dni roboczych, with
                        fractional halves on the genitive "dnia roboczego"); days is the
                        locale-formatted display value. */}
                    {t("daysOff.costPreview", {
                      count: costDays,
                      days: formatDays(costDays, i18n.language),
                    })}
                  </Text>
                  {type === "PAID" && budget != null && (
                    <Text size="sm" c={overBudget ? "var(--lettuce-ink-error)" : "dimmed"}>
                      {t("daysOff.remainingPreview", {
                        days: formatDays(budget.remaining, i18n.language),
                        pool: budget.poolName,
                        year,
                      })}
                    </Text>
                  )}
                  {type === "PAID" && budget != null && budget.allowance == null && (
                    <Text size="xs" c="var(--lettuce-ink-warning)">
                      {t(onBehalf ? "daysOff.budget.noAllowanceOnBehalf" : "daysOff.budget.noAllowance")}
                    </Text>
                  )}
                </Stack>
              </Paper>
            )}
            {overBudget && (
              <Alert color="red" variant="light">
                {t(onBehalf ? "daysOff.error.overBudgetOnBehalf" : "daysOff.error.overBudget")}
              </Alert>
            )}

            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}

            <FormFooter>
              <Button type="button" variant="default" onClick={requestCancel} disabled={submitting}>
                {t("common.action.cancel")}
              </Button>
              <Button onClick={() => void submit()} loading={submitting} disabled={!submittable}>
                {t(onBehalf ? "daysOff.action.submitAutoAccepted" : "daysOff.action.submitRequest")}
              </Button>
            </FormFooter>
          </Stack>
        </Paper>
      </Container>

      <DiscardGuard {...guardProps} />
    </>
  );
}
