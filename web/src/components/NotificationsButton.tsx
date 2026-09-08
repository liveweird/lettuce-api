import { dynamicKey } from "../utils/i18nKey";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  Indicator,
  Drawer,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconArrowBackUp,
  IconBeach,
  IconBell,
  IconBellOff,
  IconCalendarEvent,
  IconChartLine,
  IconCheck,
  IconChecks,
  IconClipboardText,
  IconExternalLink,
  IconHeartRateMonitor,
  IconEyeOff,
  IconKey,
  IconMessageQuestion,
  IconNotebook,
  IconPencil,
  IconSend,
  IconStairsUp,
  IconTargetArrow,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router-dom";
import { deleteNotification, listNotifications, markAllNotificationsSeen, markNotificationSeen, markNotificationUnseen, type NotificationItem } from "../api/notifications";
import {
  formatIsoDate,
  formatIsoMonth,
} from "../utils/datetime";
import { formatGoalValue } from "../utils/goalValues";
import { toRelativePath } from "../utils/url";
import { loadErrorMessage } from "../utils/saveError";
import CenteredLoader from "./CenteredLoader";
import DateCell from "./DateCell";
import EmptyState from "./EmptyState";
import PaginationBar from "./PaginationBar";

// The i18n key per notification type. The message is rendered in the viewer's language from
// notifications.event.* with the party names (proper nouns) interpolated from `params`.
const EVENT_KEY: Record<NotificationItem["type"], string> = {
  FEEDBACK_REQUESTED_TO_PROVIDER: "requestedToProvider",
  FEEDBACK_REQUESTED_TO_REQUESTER: "requestedToRequester",
  FEEDBACK_SENT_TO_SUBJECT: "sentToSubject",
  FEEDBACK_SENT_TO_PROVIDER: "sentToProvider",
  FEEDBACK_SENT_TO_REQUESTER: "sentToRequester",
  FEEDBACK_SENT_TO_MANAGER: "sentToManager",
  FEEDBACK_REJECTED_TO_REQUESTER: "rejectedToRequester",
  FEEDBACK_PICKED_UP_TO_REQUESTER: "pickedUpToRequester",
  FEEDBACK_WITHDRAWN_TO_SUBJECT: "withdrawnToSubject",
  FEEDBACK_WITHDRAWN_TO_REQUESTER: "withdrawnToRequester",
  FEEDBACK_DELETED_TO_REQUESTER: "deletedToRequester",
  FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER: "requestExpiredToRequester",
  FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER: "requestExpiredToProvider",
  ONE_ON_ONE_CREATED_TO_SUBORDINATE: "oneOnOneCreated",
  ONE_ON_ONE_CREATED_TO_MANAGER: "oneOnOneCreatedToManager",
  GOAL_ACTIVATED_TO_SUBORDINATE: "goalActivated",
  GOAL_DEACTIVATED_TO_SUBORDINATE: "goalDeactivated",
  GOAL_ARCHIVED_TO_SUBORDINATE: "goalArchived",
  GOAL_REOPENED_TO_SUBORDINATE: "goalReopened",
  GOAL_PROGRESS_UPDATED_TO_SUBORDINATE: "goalProgressUpdatedToSubordinate",
  GOAL_PROGRESS_UPDATED_TO_MANAGER: "goalProgressUpdatedToManager",
  TEAM_KPI_ACTIVATED_TO_MEMBER: "teamKpiActivated",
  TEAM_KPI_DEACTIVATED_TO_MEMBER: "teamKpiDeactivated",
  TEAM_KPI_ARCHIVED_TO_MEMBER: "teamKpiArchived",
  TEAM_KPI_REOPENED_TO_MEMBER: "teamKpiReopened",
  TEAM_KPI_VALUE_RECORDED_TO_MEMBER: "teamKpiValueRecorded",
  TEAM_KPI_VALUE_CORRECTED_TO_MEMBER: "teamKpiValueCorrected",
  TEAM_KPI_VALUE_REMOVED_TO_MEMBER: "teamKpiValueRemoved",
  PERFORMANCE_REVIEW_PUBLISHED_TO_SUBORDINATE: "performanceReviewPublished",
  PERFORMANCE_REVIEW_UNPUBLISHED_TO_SUBORDINATE: "performanceReviewUnpublished",
  DAYS_OFF_REQUESTED_TO_MANAGER: "daysOffRequested",
  DAYS_OFF_ACCEPTED_TO_OWNER: "daysOffAccepted",
  DAYS_OFF_REJECTED_TO_OWNER: "daysOffRejected",
  DAYS_OFF_CANCELLED_TO_MANAGER: "daysOffCancelled",
  DAYS_OFF_CANCELLED_TO_OWNER: "daysOffCancelledToOwner",
  DAYS_OFF_CORRECTED_TO_OWNER: "daysOffCorrected",
  DAYS_OFF_RECORDED_TO_OWNER: "daysOffRecordedToOwner",
  DAYS_OFF_RECORDED_TO_MANAGER: "daysOffRecordedToManager",
  DAYS_OFF_ALLOWANCE_CHANGED: "daysOffAllowanceChanged",
  PULSE_CYCLE_SCHEDULED: "pulseCycleScheduled",
  PULSE_CYCLE_OPENED: "pulseCycleOpened",
  PULSE_RESULTS_AVAILABLE: "pulseResultsAvailable",
  PULSE_CYCLE_CANCELLED: "pulseCycleCancelled",
  IMPACT_ENTRY_CREATED_TO_MANAGER: "impactEntryCreated",
  IMPACT_ENTRY_UPDATED_TO_MANAGER: "impactEntryUpdated",
  IMPACT_ENTRY_DELETED_TO_MANAGER: "impactEntryDeleted",
  CAREER_POSITION_STARTED_TO_USER: "careerPositionStarted",
  PASSWORD_CHANGED: "passwordChanged",
};

// The per-key param formatting spec — the third table beside EVENT_KEY/TYPE_META: which raw
// wire params get localized before interpolation, and which param drives the i18next context
// variant (default `self`, the "about yourself" wording). Keys absent here interpolate
// verbatim (party names are proper nouns; days-off `days` is a plain "1.5"-style number).
type ParamFormatSpec = {
  /** Raw ISO YYYY-MM-DD params → the viewer's locale (formatIsoDate). */
  dateParams?: string[];
  /** Raw ISO YYYY-MM period bounds → the viewer's locale (formatIsoMonth). */
  monthParams?: string[];
  /** Raw Double params formatted per the KPI's type — the "%" suffix for PERCENTAGE. */
  kpiValueParams?: string[];
  /** Wire enum params translated via the given key prefix (param → prefix). */
  enumParams?: Record<string, string>;
  /** The param whose value picks the i18next context variant (default "self"). */
  contextParam?: string;
  /** The paid pool's name (v3.2.1): when present it replaces the `type` enum word in the
   * rendered text (a PAID request names its pool; UNPAID rows carry none). */
  poolNameParam?: string;
};

// The team-KPI data-point kinds are the only ones carrying numeric values; the rest localize
// dates/months and the days-off type enum.
const KPI_VALUE_SPEC: ParamFormatSpec = {
  kpiValueParams: ["value", "fromValue", "toValue"],
  dateParams: ["date", "fromDate", "toDate"],
};
const REVIEW_PERIOD_SPEC: ParamFormatSpec = { monthParams: ["startMonth", "endMonth"] };
const DAYS_OFF_SPEC: ParamFormatSpec = {
  dateParams: ["startDate", "endDate"],
  enumParams: { type: "daysOff.type" },
  poolNameParam: "pool",
};
// The cancel pair additionally words the actor (OWNER/MANAGER) via i18next context on `by`
// (v2.31.0); rows minted before the rework carry no `by` and fall back to the base key.
const DAYS_OFF_CANCEL_SPEC: ParamFormatSpec = { ...DAYS_OFF_SPEC, contextParam: "by" };
const PULSE_SPEC: ParamFormatSpec = { dateParams: ["openDate", "closeDate"] };
const IMPACT_LOG_SPEC: ParamFormatSpec = { dateParams: ["periodStart", "periodEnd"] };

const PARAM_FORMAT: Partial<Record<string, ParamFormatSpec>> = {
  teamKpiValueRecorded: KPI_VALUE_SPEC,
  teamKpiValueCorrected: KPI_VALUE_SPEC,
  teamKpiValueRemoved: KPI_VALUE_SPEC,
  performanceReviewPublished: REVIEW_PERIOD_SPEC,
  performanceReviewUnpublished: REVIEW_PERIOD_SPEC,
  daysOffRequested: DAYS_OFF_SPEC,
  daysOffAccepted: DAYS_OFF_SPEC,
  daysOffRejected: DAYS_OFF_SPEC,
  daysOffCancelled: DAYS_OFF_CANCEL_SPEC,
  daysOffCancelledToOwner: DAYS_OFF_CANCEL_SPEC,
  daysOffRecordedToOwner: DAYS_OFF_SPEC,
  daysOffRecordedToManager: DAYS_OFF_SPEC,
  // The correction kind words ADD/SUBTRACT via i18next context.
  daysOffCorrected: { contextParam: "operation" },
  pulseCycleScheduled: PULSE_SPEC,
  pulseCycleOpened: PULSE_SPEC,
  pulseResultsAvailable: PULSE_SPEC,
  pulseCycleCancelled: PULSE_SPEC,
  impactEntryCreated: IMPACT_LOG_SPEC,
  impactEntryUpdated: IMPACT_LOG_SPEC,
  impactEntryDeleted: IMPACT_LOG_SPEC,
  careerPositionStarted: { dateParams: ["startDate"] },
};

function describeNotification(n: NotificationItem, t: TFunction, locale: string): string {
  const key = EVENT_KEY[n.type];
  if (!key) return n.type; // forward-compat: an unknown kind → show the raw type
  const params: Record<string, string | undefined> = { ...(n.params ?? {}) };
  const spec = PARAM_FORMAT[key] ?? {};
  // Rows minted before the paid pools (v3.2.0) carry no `pool` — they concerned the only pool.
  if ((key === "daysOffCorrected" || key === "daysOffAllowanceChanged") && params.pool == null) {
    params.pool = t("daysOff.pool.legacyDefault");
  }
  // Anything unparseable passes through raw (the wire value beats "Invalid Date"/NaN).
  const kpiType = params.kpiType === "PERCENTAGE" ? "PERCENTAGE" : "NUMBER";
  for (const k of spec.kpiValueParams ?? []) {
    const parsed = Number(params[k]);
    if (params[k] != null && Number.isFinite(parsed)) {
      params[k] = formatGoalValue(kpiType, parsed, locale);
    }
  }
  for (const k of spec.dateParams ?? []) {
    if (params[k] != null) params[k] = formatIsoDate(params[k]!, locale);
  }
  for (const k of spec.monthParams ?? []) {
    if (params[k] != null) params[k] = formatIsoMonth(params[k]!, locale);
  }
  const enumParams = { ...(spec.enumParams ?? {}) };
  const poolName = spec.poolNameParam ? params[spec.poolNameParam] : undefined;
  if (poolName != null) {
    params.type = poolName;
    delete enumParams.type;
  }
  for (const [k, prefix] of Object.entries(enumParams)) {
    if (params[k] != null) params[k] = t(dynamicKey(`${prefix}.${params[k]}`));
  }
  const context = params[spec.contextParam ?? "self"];
  return t(dynamicKey(`notifications.event.${key}`), { ...params, context });
}

// Per-type row icon + accent color, for scannability. Same forward-compat stance as
// EVENT_KEY: an unknown kind falls back to the plain bell.
const TYPE_META: Record<NotificationItem["type"], { icon: typeof IconBell; color: string }> = {
  FEEDBACK_REQUESTED_TO_PROVIDER: { icon: IconMessageQuestion, color: "blue" },
  FEEDBACK_REQUESTED_TO_REQUESTER: { icon: IconMessageQuestion, color: "blue" },
  FEEDBACK_SENT_TO_SUBJECT: { icon: IconSend, color: "teal" },
  FEEDBACK_SENT_TO_PROVIDER: { icon: IconSend, color: "teal" },
  FEEDBACK_SENT_TO_REQUESTER: { icon: IconSend, color: "teal" },
  FEEDBACK_SENT_TO_MANAGER: { icon: IconSend, color: "teal" },
  FEEDBACK_REJECTED_TO_REQUESTER: { icon: IconX, color: "red" },
  FEEDBACK_PICKED_UP_TO_REQUESTER: { icon: IconPencil, color: "cyan" },
  FEEDBACK_WITHDRAWN_TO_SUBJECT: { icon: IconArrowBackUp, color: "orange" },
  FEEDBACK_WITHDRAWN_TO_REQUESTER: { icon: IconArrowBackUp, color: "orange" },
  FEEDBACK_DELETED_TO_REQUESTER: { icon: IconTrash, color: "gray" },
  // The auto-expiry pair (v3.8.0): distinct from the manual-reject red — a system-driven decline.
  FEEDBACK_REQUEST_EXPIRED_TO_REQUESTER: { icon: IconX, color: "gray" },
  FEEDBACK_REQUEST_EXPIRED_TO_PROVIDER: { icon: IconX, color: "gray" },
  ONE_ON_ONE_CREATED_TO_SUBORDINATE: { icon: IconCalendarEvent, color: "grape" },
  ONE_ON_ONE_CREATED_TO_MANAGER: { icon: IconCalendarEvent, color: "grape" },
  GOAL_ACTIVATED_TO_SUBORDINATE: { icon: IconTargetArrow, color: "teal" },
  GOAL_DEACTIVATED_TO_SUBORDINATE: { icon: IconTargetArrow, color: "orange" },
  GOAL_ARCHIVED_TO_SUBORDINATE: { icon: IconTargetArrow, color: "blue" },
  GOAL_REOPENED_TO_SUBORDINATE: { icon: IconTargetArrow, color: "cyan" },
  GOAL_PROGRESS_UPDATED_TO_SUBORDINATE: { icon: IconTargetArrow, color: "indigo" },
  GOAL_PROGRESS_UPDATED_TO_MANAGER: { icon: IconTargetArrow, color: "indigo" },
  TEAM_KPI_ACTIVATED_TO_MEMBER: { icon: IconChartLine, color: "teal" },
  TEAM_KPI_DEACTIVATED_TO_MEMBER: { icon: IconChartLine, color: "orange" },
  TEAM_KPI_ARCHIVED_TO_MEMBER: { icon: IconChartLine, color: "blue" },
  TEAM_KPI_REOPENED_TO_MEMBER: { icon: IconChartLine, color: "cyan" },
  TEAM_KPI_VALUE_RECORDED_TO_MEMBER: { icon: IconChartLine, color: "teal" },
  TEAM_KPI_VALUE_CORRECTED_TO_MEMBER: { icon: IconChartLine, color: "indigo" },
  TEAM_KPI_VALUE_REMOVED_TO_MEMBER: { icon: IconChartLine, color: "gray" },
  PERFORMANCE_REVIEW_PUBLISHED_TO_SUBORDINATE: { icon: IconClipboardText, color: "teal" },
  PERFORMANCE_REVIEW_UNPUBLISHED_TO_SUBORDINATE: { icon: IconClipboardText, color: "orange" },
  DAYS_OFF_REQUESTED_TO_MANAGER: { icon: IconBeach, color: "yellow" },
  DAYS_OFF_ACCEPTED_TO_OWNER: { icon: IconBeach, color: "teal" },
  DAYS_OFF_REJECTED_TO_OWNER: { icon: IconBeach, color: "red" },
  DAYS_OFF_CANCELLED_TO_MANAGER: { icon: IconBeach, color: "gray" },
  DAYS_OFF_CANCELLED_TO_OWNER: { icon: IconBeach, color: "gray" },
  DAYS_OFF_CORRECTED_TO_OWNER: { icon: IconBeach, color: "teal" },
  DAYS_OFF_RECORDED_TO_OWNER: { icon: IconBeach, color: "teal" },
  DAYS_OFF_RECORDED_TO_MANAGER: { icon: IconBeach, color: "teal" },
  DAYS_OFF_ALLOWANCE_CHANGED: { icon: IconBeach, color: "teal" },
  PULSE_CYCLE_SCHEDULED: { icon: IconHeartRateMonitor, color: "blue" },
  PULSE_CYCLE_OPENED: { icon: IconHeartRateMonitor, color: "teal" },
  PULSE_RESULTS_AVAILABLE: { icon: IconHeartRateMonitor, color: "grape" },
  PULSE_CYCLE_CANCELLED: { icon: IconHeartRateMonitor, color: "gray" },
  IMPACT_ENTRY_CREATED_TO_MANAGER: { icon: IconNotebook, color: "teal" },
  IMPACT_ENTRY_UPDATED_TO_MANAGER: { icon: IconNotebook, color: "indigo" },
  IMPACT_ENTRY_DELETED_TO_MANAGER: { icon: IconNotebook, color: "gray" },
  CAREER_POSITION_STARTED_TO_USER: { icon: IconStairsUp, color: "indigo" },
  PASSWORD_CHANGED: { icon: IconKey, color: "orange" },
};

// Poll the bell so notifications minted elsewhere (e.g. someone sending you feedback) show up
// without a manual refresh. `refetchIntervalInBackground` defaults to false, so polling pauses
// while the tab is hidden. Own-action freshness comes from invalidating ["notifications"] in the
// feedback flows.
const UNREAD_REFETCH_MS = 30_000;

const PAGE_SIZE = 50;

export default function NotificationsButton() {
  const { t, i18n } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  function openPanel() {
    setPage(1); // always reopen on the newest page
    open();
  }

  // Cheap unread count: pageSize 1, read only `total`.
  const unreadQuery = useQuery({
    queryKey: ["notifications", "unread"],
    queryFn: () => listNotifications({ page: 1, pageSize: 1, wasSeen: false }),
    refetchInterval: UNREAD_REFETCH_MS,
  });
  const unreadCount = unreadQuery.data?.total ?? 0;

  const listQuery = useQuery({
    queryKey: ["notifications", "list", page],
    queryFn: () => listNotifications({ page, pageSize: PAGE_SIZE, sort: "-timestamp" }),
    enabled: opened,
    refetchInterval: UNREAD_REFETCH_MS, // only polls while the modal is open (enabled)
    placeholderData: keepPreviousData, // no empty flash while stepping between pages
  });
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Deleting the last row of the last page (or the 30s poll observing someone else's
  // deletion) leaves an empty page — step back. Adjusted during render, the React-documented
  // replacement for the set-state-in-effect shape: React restarts the render immediately
  // instead of committing a wasted empty frame.
  if (listQuery.data && listQuery.data.items.length === 0 && page > 1) {
    setPage(page - 1);
  }

  const markSeen = useMutation({
    mutationFn: (id: number) => markNotificationSeen(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markUnseen = useMutation({
    mutationFn: (id: number) => markNotificationUnseen(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAllSeen = useMutation({
    mutationFn: () => markAllNotificationsSeen(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => deleteNotification(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  function goTo(n: NotificationItem) {
    if (!n.link) return;
    // Following the link means the user has acted on the notification — mark it seen.
    // Fire-and-forget: navigation must not block on it, and a failure just leaves it unseen.
    if (!n.wasSeen) markSeen.mutate(n.id);
    close();
    navigate(toRelativePath(n.link));
  }

  return (
    <>
      <Indicator
        inline
        size={18}
        offset={4}
        color="red.8"
        label={unreadCount > 99 ? "99+" : unreadCount}
        disabled={unreadCount === 0}
      >
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          onClick={openPanel}
          aria-label={`${t("notifications.title")} (${t("notifications.unread", { count: unreadCount })})`}
        >
          <IconBell size={18} />
        </ActionIcon>
      </Indicator>

      {/* A right-hand panel (v3.3.0 — a Drawer instead of the centered Modal): the composed
          header keeps "Mark all as seen" beside the close button, the list scrolls inside the
          panel, and the compact PaginationBar pages it. The compound Root reads "DrawerRoot"
          defaults, not the theme's "Drawer" entry — hence the explicit position, and the
          overlay dim/blur registered on DrawerOverlay in theme.ts (v3.5.2). */}
      <Drawer.Root opened={opened} onClose={close} position="right" size={440}>
        <Drawer.Overlay />
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{t("notifications.title")}</Drawer.Title>
            <Group gap="sm">
              {unreadCount > 0 && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconChecks size={14} />}
                  onClick={() => markAllSeen.mutate()}
                  loading={markAllSeen.isPending}
                >
                  {t("notifications.markAllSeen")}
                </Button>
              )}
              <Drawer.CloseButton aria-label={t("common.action.close")} />
            </Group>
          </Drawer.Header>
          <Drawer.Body>
            {listQuery.isLoading ? (
              <CenteredLoader />
            ) : listQuery.isError ? (
              <Alert color="red" variant="light" title={t("notifications.loadError")}>
                {loadErrorMessage(listQuery.error, t)}
              </Alert>
            ) : (listQuery.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                icon={<IconBellOff size={32} stroke={1.2} color="var(--mantine-color-dimmed)" />}
                label={t("notifications.empty")}
              />
            ) : (
              /* Semantic list (rows are <li>) — also the stable hook the e2e helpers use. */
              <Box component="ul" m={0} p={0} style={{ listStyle: "none" }}>
                {listQuery.data!.items.map((n, i) => {
                  const meta = TYPE_META[n.type] ?? { icon: IconBell, color: "gray" };
                  const TypeIcon = meta.icon;
                  return (
                    <Box
                      key={n.id}
                      component="li"
                      py="sm"
                      px={4}
                      style={{
                        borderTop:
                          i > 0 ? "1px solid var(--mantine-color-default-border)" : undefined,
                      }}
                    >
                      <Group align="flex-start" wrap="nowrap" gap="sm">
                        {/* The brand-green dot (the Indicator's primary-colour default) is
                            decorative — seen-state is conveyed by the bold text and the
                            offered action. */}
                        <Indicator size={9} offset={3} disabled={n.wasSeen}>
                          <ThemeIcon variant="light" color={meta.color} radius="xl" size="lg">
                            <TypeIcon size={16} />
                          </ThemeIcon>
                        </Indicator>
                        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                          <Text size="sm" fw={n.wasSeen ? 400 : 600} c={n.wasSeen ? "dimmed" : undefined}>
                            {describeNotification(n, t, i18n.language)}
                          </Text>
                          <DateCell value={n.timestamp} mode="relative" size="xs" dimmed />
                        </Stack>
                        <Group gap={4} wrap="nowrap">
                          {!n.wasSeen && (
                            <Tooltip label={t("notifications.markSeen")}>
                              <ActionIcon
                                variant="subtle"
                                onClick={() => markSeen.mutate(n.id)}
                                loading={markSeen.isPending && markSeen.variables === n.id}
                                aria-label={t("notifications.markSeenAria", { id: n.id })}
                              >
                                <IconCheck size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {n.wasSeen && (
                            <Tooltip label={t("notifications.markUnseen")}>
                              <ActionIcon
                                variant="subtle"
                                color="gray"
                                onClick={() => markUnseen.mutate(n.id)}
                                loading={markUnseen.isPending && markUnseen.variables === n.id}
                                aria-label={t("notifications.markUnseenAria", { id: n.id })}
                              >
                                <IconEyeOff size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          {n.link && (
                            <Tooltip label={t("notifications.goTo")}>
                              <ActionIcon
                                variant="subtle"
                                onClick={() => goTo(n)}
                                aria-label={t("notifications.goToAria", { id: n.id })}
                              >
                                <IconExternalLink size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                          <Tooltip label={t("notifications.delete")}>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              onClick={() => remove.mutate(n.id)}
                              loading={remove.isPending && remove.variables === n.id}
                              aria-label={t("notifications.deleteAria", { id: n.id })}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Group>
                    </Box>
                  );
                })}
              </Box>
            )}
            {totalPages > 1 && (
              <Box mt="sm">
                <PaginationBar total={total} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />
              </Box>
            )}
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
    </>
  );
}
