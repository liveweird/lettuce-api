/* eslint-disable react-refresh/only-export-components -- pairs the useReviewPeriodOptions hook and its ReviewPeriodOption type with the renderPeriodOption Select renderOption helper, which returns JSX but isn't a mountable component */
import { useMemo } from "react";
import { Badge, Group } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listReviewPeriods, type ReviewPeriod } from "../api/reviews";
import { currentIsoMonth, formatMonthRange, isCurrentPeriod } from "../utils/datetime";

export type ReviewPeriodOption = {
  value: string;
  label: string;
  /** True for the period containing today — drives the "Current" marker in pickers. */
  current?: boolean;
  /** True while the period hasn't started (start month after the current month). Data only —
   *  the create screen disables such options (the server rejects them), while the viewing
   *  pickers (dashboard, table filter) deliberately keep them selectable. */
  future?: boolean;
};

// The shared option renderer for period Selects: the plain label plus a compact "Current"
// badge on the period containing today. The marker deliberately stays OUT of the label text —
// Mantine mirrors the label into the input value, so a label suffix would leak into the
// closed-state input (and every test asserting the plain range). Tolerates options without
// the flag (e.g. a prepended "All" filter option).
export function renderPeriodOption({ option }: { option: ReviewPeriodOption }) {
  return <PeriodOptionLabel option={option} />;
}

function PeriodOptionLabel({ option }: { option: ReviewPeriodOption }) {
  const { t } = useTranslation();
  return (
    <Group gap="xs" wrap="nowrap" justify="space-between" flex={1}>
      <span>{option.label}</span>
      {option.current && (
        <Badge size="xs" variant="light" color="lettuce">
          {t("performanceReview.periods.currentBadge")}
        </Badge>
      )}
    </Group>
  );
}

// The one cached review-periods query (the ["reviewPeriods"] key is shared with every
// mutation's invalidation) mapped to Mantine Select options, newest first — the
// useDictionaryOptions shape. Consumers that need the raw timeline (the admin screen,
// the dashboard's empty check) read `periods`; the pickers read `options` and pass
// `renderPeriodOption` so the current period is marked.
export function useReviewPeriodOptions(enabled = true): {
  periods: ReviewPeriod[] | undefined;
  options: ReviewPeriodOption[];
  isLoading: boolean;
  isError: boolean;
} {
  const { i18n } = useTranslation();
  const { data: periods, isLoading, isError } = useQuery({
    queryKey: ["reviewPeriods"],
    queryFn: listReviewPeriods,
    staleTime: 5 * 60 * 1000,
    enabled,
  });

  const options = useMemo(
    () =>
      [...(periods ?? [])].reverse().map((p) => ({
        value: String(p.id),
        label: formatMonthRange(p.startMonth, p.endMonth, i18n.language),
        current: isCurrentPeriod(p.startMonth, p.endMonth),
        future: p.startMonth > currentIsoMonth(),
      })),
    [periods, i18n.language],
  );

  return { periods, options, isLoading, isError };
}
