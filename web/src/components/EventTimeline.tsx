import type { ReactNode } from "react";
import { Alert, Loader, Text, Timeline } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../utils/datetime";
import { loadErrorMessage } from "../utils/saveError";

type TimelineEvent = { id: number; userName: string; timestamp: number };

/**
 * The shared audit-history timeline shell behind the five per-area histories (feedback,
 * goals, 1:1s, team KPIs, reviews): loading spinner, load-error Alert, empty-state note,
 * then the newest-first Timeline with a `who · when` meta line per event. The per-area
 * components keep their query and `describeEvent` renderer and pass them in — only the
 * shell is shared (2026-08 review round; it was near-copied five times, and only the
 * review history had a loading state).
 */
export default function EventTimeline<E extends TimelineEvent>({
  events,
  isLoading,
  isError,
  error,
  emptyMessage,
  renderTitle,
  renderBody,
  renderActor,
}: {
  events: E[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  emptyMessage: string;
  renderTitle: (e: E) => string;
  // Optional per-event content under the title (the goal progress comment) — most areas omit it.
  renderBody?: (e: E) => ReactNode;
  // Optional override for the `who` half of the meta line (default: e.userName) — an automated
  // event (the feedback expiry sweep) is stored against a user id for schema reasons but wasn't
  // performed by them, so the caller can substitute a localized system label instead.
  renderActor?: (e: E) => string;
}) {
  const { t, i18n } = useTranslation();

  if (isLoading) return <Loader size="sm" />;
  if (isError) {
    // A failed history load must not masquerade as an empty history (v2.24.0).
    return (
      <Alert color="red" variant="light">
        {loadErrorMessage(error, t)}
      </Alert>
    );
  }

  if (!events || events.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {emptyMessage}
      </Text>
    );
  }

  return (
    <Timeline bulletSize={12} lineWidth={2}>
      {events.map((e) => (
        <Timeline.Item key={e.id} title={renderTitle(e)}>
          {renderBody?.(e)}
          <Text size="xs" c="dimmed">
            {renderActor?.(e) ?? e.userName} · {formatDateTime(e.timestamp, i18n.language)}
          </Text>
        </Timeline.Item>
      ))}
    </Timeline>
  );
}
