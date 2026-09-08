/* eslint-disable react-refresh/only-export-components -- deliberately mixed file (the auth.tsx precedent): goal value/overdue helper functions share a home with their small presentational components */
// A deliberately mixed file (the auth.tsx precedent): the goal value/overdue helpers and their
// small presentational components share one home, at the cost of Fast Refresh for it.
import { Group, Progress, Stack, Text } from "@mantine/core";
import StatusPill from "../components/StatusPill";
import { useTranslation } from "react-i18next";
import type { GoalResponse, GoalStatus, GoalType, TargetDirection } from "../api/goals";
import ReadOnlyField from "../components/ReadOnlyField";
import { todayIsoDate } from "./datetime";

// A goal is overdue only while ACTIVE (a draft has no deadline pressure yet, a closed goal is a
// record) — ISO strings compare chronologically, so a plain string compare suffices.
export function isGoalOverdue(status: GoalStatus, dueDate: string): boolean {
  return status === "ACTIVE" && dueDate < todayIsoDate();
}

// The "past its due date" pill next to due-date renderings (table cell, view/edit headers).
// Orange = warning; red stays reserved for errors/destructive actions.
export function OverdueBadge() {
  const { t } = useTranslation();
  return (
    <StatusPill color="orange" dot>
      {t("goal.overdue")}
    </StatusPill>
  );
}

// A goal's numeric value rendered for its type: locale-formatted number, "%"-suffixed for
// PERCENTAGE, an em dash for null (a PLAN goal's numeric columns). PLAN progress is its
// milestone tally, rendered by GoalCurrentValue / MilestoneList instead.
export function formatGoalValue(type: GoalType, value: number | null | undefined, locale: string): string {
  if (type === "PLAN" || value == null) return "—";
  const formatted = new Intl.NumberFormat(locale).format(value);
  return type === "PERCENTAGE" ? `${formatted}%` : formatted;
}

// The target with its direction glyph ("≥ 10" / "≤ 5%", v2.41.0) — every TARGET render site
// uses this; current-value sites keep the bare formatGoalValue. Directionless (PLAN/null)
// falls back to the plain rendering.
export function formatTargetValue(
  type: GoalType,
  value: number | null | undefined,
  direction: TargetDirection | null | undefined,
  locale: string,
): string {
  const formatted = formatGoalValue(type, value, locale);
  if (type === "PLAN" || value == null || !direction) return formatted;
  return `${direction === "AT_LEAST" ? "≥" : "≤"} ${formatted}`;
}

// Which side of the target is good: reach-or-exceed for AT_LEAST, stay-at-or-below for
// AT_MOST — meeting the target exactly always counts as good (the server's documented rule).
export function meetsTarget(direction: TargetDirection, value: number, target: number): boolean {
  return direction === "AT_LEAST" ? value >= target : value <= target;
}

// The signed distance from the target ("+3", "−2%"; "0" when exactly on it) — the KPI values
// list / goal current-value delta. Sign says where the value sits; color (TargetDelta) says
// whether that side is good.
export function formatTargetDelta(
  type: GoalType,
  value: number,
  target: number,
  locale: string,
): string {
  const formatted = new Intl.NumberFormat(locale, { signDisplay: "exceptZero" }).format(value - target);
  return type === "PERCENTAGE" ? `${formatted}%` : formatted;
}

// The colored above/below-target cue (v2.41.0): teal on the good side of the target, red on
// the bad one (the pulse deltaColor idiom — semantic success is teal, never brand green).
export function TargetDelta({
  type,
  value,
  target,
  direction,
  locale,
}: {
  type: GoalType;
  value: number;
  target: number;
  direction: TargetDirection;
  locale: string;
}) {
  return (
    <StatusPill color={meetsTarget(direction, value, target) ? "teal" : "red"} dot>
      {formatTargetDelta(type, value, target, locale)}
    </StatusPill>
  );
}

// The per-type CURRENT value, compact (table cells): the "done / total" milestone tally for
// PLAN (an em dash while a draft has no milestones yet), the formatted number otherwise. The
// single home of that type branch.
export function GoalCurrentValue({
  type,
  currentValue,
  milestonesDone,
  milestonesTotal,
  locale,
}: {
  type: GoalType;
  currentValue: number | null | undefined;
  milestonesDone: number | null | undefined;
  milestonesTotal: number | null | undefined;
  locale: string;
}) {
  if (type === "PLAN") {
    if (!milestonesTotal) return <>—</>;
    return <>{`${milestonesDone ?? 0} / ${milestonesTotal}`}</>;
  }
  return <>{formatGoalValue(type, currentValue, locale)}</>;
}

// The read-only milestone list (view screen + archived documents): a check square per row,
// done rows visibly settled — struck through + dimmed (v2.9.0, the completed-state emphasis).
function MilestoneList({ milestones }: { milestones: GoalResponse["milestones"] }) {
  return (
    <Stack gap={6}>
      {milestones.map((milestone) => (
        <Group key={milestone.id} gap="xs" wrap="nowrap" align="flex-start">
          <Text size="sm" c={milestone.done ? "teal" : "dimmed"} style={{ flexShrink: 0 }} aria-hidden>
            {milestone.done ? "☑" : "☐"}
          </Text>
          <Text
            size="sm"
            c={milestone.done ? "dimmed" : undefined}
            style={{
              textDecoration: milestone.done ? "line-through" : undefined,
              whiteSpace: "pre-wrap",
            }}
          >
            {milestone.description}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

// The type-specific value block for the read-only document: a progress bar for PERCENTAGE,
// two labeled numbers for NUMBER, the milestone list (+ "x of y done") for PLAN.
export function GoalValues({ goal, locale }: { goal: GoalResponse; locale: string }) {
  const { t } = useTranslation();
  if (goal.type === "PLAN") {
    const done = goal.milestones.filter((m) => m.done).length;
    return (
      <ReadOnlyField label={t("goal.milestones")}>
        {goal.milestones.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t("goal.noMilestones")}
          </Text>
        ) : (
          <Stack gap="xs">
            <MilestoneList milestones={goal.milestones} />
            <Text size="sm" c="dimmed">
              {t("goal.milestonesDone", { done, total: goal.milestones.length })}
            </Text>
          </Stack>
        )}
      </ReadOnlyField>
    );
  }
  const target = formatTargetValue(goal.type, goal.targetValue, goal.targetDirection, locale);
  // The sentence under the progress bar keeps the plain target — "45% of the ≥ 90% target"
  // would read as noise; the glyph lives on the Target field.
  const plainTarget = formatGoalValue(goal.type, goal.targetValue, locale);
  const current = formatGoalValue(goal.type, goal.currentValue, locale);
  const delta =
    goal.currentValue != null && goal.targetValue != null && goal.targetDirection != null ? (
      <TargetDelta
        type={goal.type}
        value={goal.currentValue}
        target={goal.targetValue}
        direction={goal.targetDirection}
        locale={locale}
      />
    ) : null;
  return (
    <Stack gap="xs">
      <Group gap="xl">
        <ReadOnlyField label={t("goal.target")}>
          <Text size="sm">{target}</Text>
        </ReadOnlyField>
        <ReadOnlyField label={t("goal.current")}>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">{goal.currentValue == null ? t("goal.noValueYet") : current}</Text>
            {delta}
          </Group>
        </ReadOnlyField>
      </Group>
      {goal.type === "PERCENTAGE" && goal.currentValue != null && (
        <>
          <Progress
            value={goal.currentValue}
            color={
              goal.targetValue != null &&
              meetsTarget(goal.targetDirection ?? "AT_LEAST", goal.currentValue, goal.targetValue)
                ? "teal"
                : "lettuce"
            }
            aria-label={t("goal.current")}
          />
          <Text size="sm" c="dimmed">
            {t("goal.currentOfTarget", { current, target: plainTarget })}
          </Text>
        </>
      )}
    </Stack>
  );
}
