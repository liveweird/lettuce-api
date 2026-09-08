import type { ParseKeys, TFunction } from "i18next";
import { type ReactNode } from "react";
import {
  Alert,
  Group,
  Select,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconEye, IconMessages, IconPencil } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getUserId } from "../api/session";
import { listFeedbacks, type FeedbackListView, type FeedbackPage, type FeedbackStatus, type FeedbackVisibility } from "../api/feedbacks";
import ClearableTextInput from "../components/ClearableTextInput";
import DateCell from "../components/DateCell";
import EmptyState from "../components/EmptyState";
import TableLoadingRow from "../components/TableLoadingRow";
import { StatusBadge, VisibilityBadge } from "../components/FeedbackBadges";
import PersonCell from "../components/PersonCell";
import RowActions from "../components/RowActions";
import FilterPanel from "../components/FilterPanel";
import PaginationBar from "../components/PaginationBar";
import ReportsScopeSelect from "../components/ReportsScopeSelect";
import SortHeader from "../components/SortHeader";
import { usePagedSort } from "../hooks/usePagedSort";
import { isOneOf, isOneOfOrNull, isString, useStoredState } from "../hooks/useStoredState";
import { lastModifiedCutoff, lastModifiedOptions, type LastModifiedWindow } from "../utils/datetime";
import { ALL_VISIBILITIES } from "../utils/feedbackVisibility";
import { feedbackEditLink, feedbackViewLink } from "../utils/feedbackLinks";
import { feedbackSubjectNames, feedbackSubjects, type FeedbackSubjectRef } from "../utils/feedbackSubjects";
import { loadErrorMessage } from "../utils/saveError";

const SORT_FIELDS = [
  "requesterName",
  "subjectName",
  "providerName",
  "visibility",
  "status",
  "lastModified",
] as const;
type SortField = (typeof SORT_FIELDS)[number];

type FeedbackRow = FeedbackPage["items"][number];

const STATUS_VALUES: FeedbackStatus[] = [
  "REQUESTED",
  "DRAFT",
  "SENT",
  "WITHDRAWN",
  "REJECTED",
];

// A filterable + sortable person column (the first column is always the requester). A column
// may hold several people — the Subject column lists every recipient (up to four, v3.1.0).
type PersonColumn = {
  field: "providerName" | "subjectName";
  labelKey: ParseKeys;
  clearFilterLabelKey: ParseKeys;
  people: (f: FeedbackRow) => FeedbackSubjectRef[];
};

const PROVIDER_COLUMN: PersonColumn = {
  field: "providerName",
  labelKey: "common.field.provider",
  clearFilterLabelKey: "feedback.clearProviderFilter",
  people: (f) => [{ id: f.providerId, name: f.providerName, deleted: f.providerDeleted }],
};

const SUBJECT_COLUMN: PersonColumn = {
  field: "subjectName",
  labelKey: "common.field.subject",
  clearFilterLabelKey: "feedback.clearSubjectFilter",
  people: (f) => feedbackSubjects(f),
};

// What the per-view action renderers get from the component.
type ActionContext = {
  currentUserId: number | null;
  // Return target carried into the View/Edit links (the `backTo` prop); unset = feedback tabs.
  backTo?: string;
  t: TFunction;
};

// The views this table renders — every list view except `kudos`, which has its own
// timeline page (pages/Kudos.tsx) instead of a table.
type TableView = Exclude<FeedbackListView, "kudos">;

// Per-view differences: which person columns appear between Requester and Visibility,
// the default sort, and how the row action (View/Edit link) is rendered. The visibility
// filter offers ALL_VISIBILITIES in every view (utils/feedbackVisibility.ts).
const VIEW_CONFIG: Record<
  TableView,
  {
    personColumns: PersonColumn[];
    defaultSortField: SortField;
    renderAction: (f: FeedbackRow, ctx: ActionContext) => ReactNode;
  }
> = {
  received: {
    personColumns: [PROVIDER_COLUMN],
    defaultSortField: "providerName",
    renderAction: (f, { t, backTo }) => (
      <RowActions
        name={feedbackSubjectNames(f)}
        primary={{
          icon: <IconEye size={16} />,
          label: t("common.action.view"),
          ariaLabel: t("feedback.viewFrom", { name: f.providerName }),
          to: feedbackViewLink(f.id, { back: backTo }),
        }}
      />
    ),
  },
  provided: {
    personColumns: [SUBJECT_COLUMN],
    defaultSortField: "subjectName",
    renderAction: (f, { t, backTo }) =>
      f.status === "REQUESTED" || f.status === "DRAFT" ? (
        <RowActions
        name={feedbackSubjectNames(f)}
        primary={{
          icon: <IconPencil size={16} />,
          label: t("common.action.edit"),
          ariaLabel: t("feedback.editFor", { name: feedbackSubjectNames(f) }),
          to: feedbackEditLink(f.id, { back: backTo }),
        }}
      />
      ) : (
        <RowActions
        name={feedbackSubjectNames(f)}
        primary={{
          icon: <IconEye size={16} />,
          label: t("common.action.view"),
          ariaLabel: t("feedback.viewFor", { name: feedbackSubjectNames(f) }),
          to: feedbackViewLink(f.id, { as: "provider", back: backTo }),
        }}
      />
      ),
  },
  // The HR auditor view (view=user&userId=X): everything X is a party to, read-only —
  // the auditor is never a party, so the action is always View.
  user: {
    personColumns: [PROVIDER_COLUMN, SUBJECT_COLUMN],
    defaultSortField: "lastModified",
    renderAction: (f, { t, backTo }) => (
      <RowActions
        name={feedbackSubjectNames(f)}
        primary={{
          icon: <IconEye size={16} />,
          label: t("common.action.view"),
          ariaLabel: t("feedback.viewFor", { name: feedbackSubjectNames(f) }),
          to: feedbackViewLink(f.id, { back: backTo }),
        }}
      />
    ),
  },
  team: {
    personColumns: [PROVIDER_COLUMN, SUBJECT_COLUMN],
    defaultSortField: "subjectName",
    renderAction: (f, { t, currentUserId, backTo }) =>
      currentUserId === f.providerId && f.status === "DRAFT" ? (
        <RowActions
        name={feedbackSubjectNames(f)}
        primary={{
          icon: <IconPencil size={16} />,
          label: t("common.action.edit"),
          ariaLabel: t("feedback.editFor", { name: feedbackSubjectNames(f) }),
          to: feedbackEditLink(f.id, { from: "team", back: backTo }),
        }}
      />
      ) : (
        <RowActions
        name={feedbackSubjectNames(f)}
        primary={{
          icon: <IconEye size={16} />,
          label: t("common.action.view"),
          ariaLabel: t("feedback.viewFor", { name: feedbackSubjectNames(f) }),
          to: feedbackViewLink(f.id, { as: "team", back: backTo }),
        }}
      />
      ),
  },
};

export default function FeedbackTable({
  view,
  providerId,
  subjectId,
  userId,
  backTo,
  settingsKey,
  emptyAction,
}: {
  view: TableView;
  // Optional exact-id scope to a single counterparty (used by the per-manager screen).
  providerId?: number;
  subjectId?: number;
  // Required with view=user (the HR auditor view): whose records to list.
  userId?: number;
  // When set, the View/Edit links return here instead of the feedback tabs.
  backTo?: string;
  // localStorage namespace for this instance's filters/sort. Defaults per view; screens
  // embedding the table in another context (the per-manager page) pass their own so their
  // settings don't bleed into the main feedback tabs.
  settingsKey?: string;
  /** The hub page's creation link for the empty state (v3.4.0, see EmptyCtaLink). */
  emptyAction?: ReactNode;
}) {
  const { t } = useTranslation();
  const currentUserId = getUserId();
  const config = VIEW_CONFIG[view];
  const visibilityOptions = ALL_VISIBILITIES.map((value) => ({
    value,
    label: t(`common.visibility.${value}`),
  }));
  const statusOptions = STATUS_VALUES.map((value) => ({
    value,
    label: t(`common.status.${value}`),
  }));
  const columnCount = config.personColumns.length + 6; // requester + preview + vis + status + modified + actions

  const storeKey = settingsKey ?? `feedbacks.${view}`;
  const [requesterFilter, setRequesterFilter] = useStoredState(
    `${storeKey}.filter.requester`, "", isString,
  );
  const [providerFilter, setProviderFilter] = useStoredState(
    `${storeKey}.filter.provider`, "", isString,
  );
  const [subjectFilter, setSubjectFilter] = useStoredState(
    `${storeKey}.filter.subject`, "", isString,
  );
  const [visibilityFilter, setVisibilityFilter] = useStoredState<FeedbackVisibility | null>(
    `${storeKey}.filter.visibility`, null, isOneOfOrNull(ALL_VISIBILITIES),
  );
  const [statusFilter, setStatusFilter] = useStoredState<FeedbackStatus | null>(
    `${storeKey}.filter.status`, null, isOneOfOrNull(STATUS_VALUES),
  );
  const [lastModifiedFilter, setLastModifiedFilter] = useStoredState<LastModifiedWindow>(
    `${storeKey}.filter.lastModified`, "all", isOneOf(["all", "week", "month"]),
  );
  // Team view only: subjects limited to direct reports (default) or the whole management chain.
  const [reportsScope, setReportsScope] = useStoredState<"direct" | "all">(
    `${storeKey}.filter.reportsScope`, "direct", isOneOf(["direct", "all"]),
  );
  const includeIndirect = view === "team" && reportsScope === "all";
  // Filters without a rendered input stay "" and count 0, so this is per-view correct.
  // `lastModifiedFilter` defaults to the truthy "all" — compare against it, not truthiness.
  const activeFilterCount =
    (requesterFilter.trim() ? 1 : 0) +
    (providerFilter.trim() ? 1 : 0) +
    (subjectFilter.trim() ? 1 : 0) +
    (visibilityFilter ? 1 : 0) +
    (statusFilter ? 1 : 0) +
    (lastModifiedFilter !== "all" ? 1 : 0) +
    (includeIndirect ? 1 : 0);

  const [debouncedRequester] = useDebouncedValue(requesterFilter, 300);
  const [debouncedProvider] = useDebouncedValue(providerFilter, 300);
  const [debouncedSubject] = useDebouncedValue(subjectFilter, 300);

  // Binds each person column's filter input to its state; only the columns in
  // `config.personColumns` render an input, so the others never leave "".
  const personFilters: Record<
    PersonColumn["field"],
    { value: string; set: (v: string) => void }
  > = {
    providerName: { value: providerFilter, set: setProviderFilter },
    subjectName: { value: subjectFilter, set: setSubjectFilter },
  };

  const { page, setPage, pageSize, setPageSize, sortField, sortDir, sortParam, toggleSort } =
    usePagedSort<SortField>(
      config.defaultSortField,
      [
        debouncedRequester,
        debouncedProvider,
        debouncedSubject,
        visibilityFilter,
        statusFilter,
        lastModifiedFilter,
        includeIndirect,
      ],
      { key: storeKey, sortFields: SORT_FIELDS },
    );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: [
      "feedbacks",
      view,
      providerId ?? null,
      subjectId ?? null,
      page,
      pageSize,
      sortParam,
      debouncedRequester,
      debouncedProvider,
      debouncedSubject,
      visibilityFilter,
      statusFilter,
      lastModifiedFilter,
      includeIndirect,
    ],
    queryFn: () =>
      listFeedbacks({
        view,
        page,
        pageSize,
        sort: sortParam,
        requesterName: debouncedRequester || undefined,
        providerName: debouncedProvider || undefined,
        subjectName: debouncedSubject || undefined,
        providerId,
        subjectId,
        visibility: visibilityFilter ?? undefined,
        status: statusFilter ?? undefined,
        lastModifiedGte: lastModifiedCutoff(lastModifiedFilter),
        includeIndirect: includeIndirect || undefined,
        userId,
      }),
    placeholderData: keepPreviousData,
  });

  const total = data?.total ?? 0;

  return (
    <Stack gap="md">
      <FilterPanel activeFilterCount={activeFilterCount} storageKey={storeKey}>
        <ClearableTextInput
          label={t("common.field.requester")}
          value={requesterFilter}
          onChange={setRequesterFilter}
          clearLabel={t("feedback.clearRequesterFilter")}
        />
        {config.personColumns.map((col) => {
          const filter = personFilters[col.field];
          return (
            <ClearableTextInput
              key={col.field}
              label={t(col.labelKey)}
              value={filter.value}
              onChange={filter.set}
              clearLabel={t(col.clearFilterLabelKey)}
            />
          );
        })}
        <Select
          label={t("common.field.visibility")}
          placeholder={t("common.state.any")}
          data={visibilityOptions}
          value={visibilityFilter}
          onChange={(v) => setVisibilityFilter((v as FeedbackVisibility | null) ?? null)}
          clearable
        />
        <Select
          label={t("common.field.status")}
          placeholder={t("common.state.any")}
          data={statusOptions}
          value={statusFilter}
          onChange={(v) => setStatusFilter((v as FeedbackStatus | null) ?? null)}
          clearable
        />
        <Select
          label={t("common.field.lastModified")}
          data={lastModifiedOptions(t)}
          value={lastModifiedFilter}
          onChange={(v) => setLastModifiedFilter((v as LastModifiedWindow) ?? "all")}
          allowDeselect={false}
        />
        {view === "team" && (
          <ReportsScopeSelect value={reportsScope} onChange={setReportsScope} />
        )}
      </FilterPanel>

      {isError && (
        <Alert color="red" variant="light" title={t("feedback.loadListError")}>
          {loadErrorMessage(error, t)}
        </Alert>
      )}

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>
              <SortHeader
                field="requesterName"
                label={t("common.field.requester")}
                activeField={sortField}
                activeDir={sortDir}
                onToggle={toggleSort}
              />
            </Table.Th>
            {config.personColumns.map((col) => (
              <Table.Th key={col.field}>
                <SortHeader
                  field={col.field}
                  label={t(col.labelKey)}
                  activeField={sortField}
                  activeDir={sortDir}
                  onToggle={toggleSort}
                />
              </Table.Th>
            ))}
            <Table.Th>{t("common.field.preview")}</Table.Th>
            <Table.Th>
              <SortHeader
                field="visibility"
                label={t("common.field.visibility")}
                activeField={sortField}
                activeDir={sortDir}
                onToggle={toggleSort}
              />
            </Table.Th>
            <Table.Th>
              <SortHeader
                field="status"
                label={t("common.field.status")}
                activeField={sortField}
                activeDir={sortDir}
                onToggle={toggleSort}
              />
            </Table.Th>
            <Table.Th>
              <SortHeader
                field="lastModified"
                label={t("common.field.lastModified")}
                activeField={sortField}
                activeDir={sortDir}
                onToggle={toggleSort}
              />
            </Table.Th>
            <Table.Th aria-label={t("common.table.actions")} style={{ width: 1 }} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {isLoading && !data ? (
            <TableLoadingRow colSpan={columnCount} />
          ) : data && data.items.length > 0 ? (
            data.items.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td>
                  <PersonCell
                    userId={f.requesterId}
                    name={f.requesterName}
                    deleted={f.requesterDeleted}
                    currentUserId={currentUserId}
                  />
                </Table.Td>
                {config.personColumns.map((col) => (
                  <Table.Td key={col.field} style={{ maxWidth: 280 }}>
                    {/* maxWidth caps the column; PersonaChip's root is a shrinkable flex item
                        (min-width 0, v3.3.0), so its own truncation engages inside the wrapping row. */}
                    <Group gap={4} wrap="wrap" style={{ minWidth: 0 }}>
                      {col.people(f).map((person) => (
                        <PersonCell
                          key={person.id}
                          userId={person.id}
                          name={person.name}
                          deleted={person.deleted}
                          currentUserId={currentUserId}
                        />
                      ))}
                    </Group>
                  </Table.Td>
                ))}
                {/* The fluid column (v3.4.0): takes the table's slack and truncates first.
                    Redacted rows (a requester's unfinished feedback) arrive with an empty preview. */}
                <Table.Td style={{ width: "100%", maxWidth: 0 }}>
                  <Text size="sm" c="dimmed" truncate>
                    {f.contentPreview}
                  </Text>
                </Table.Td>
                {/* width:1 + nowrap force these cells to content width so the pills never
                    truncate — the preview column is the one that gives way. */}
                <Table.Td style={{ width: 1, whiteSpace: "nowrap" }}>
                  <VisibilityBadge visibility={f.visibility} />
                </Table.Td>
                <Table.Td style={{ width: 1, whiteSpace: "nowrap" }}>
                  <StatusBadge status={f.status} />
                  {/* The requester's optional deadline (v3.8.0) — REQUESTED rows only. */}
                  {f.status === "REQUESTED" && f.expiresOn && (
                    <Text size="xs" c="dimmed" mt={2}>
                      {t("feedback.expiresRow")} <DateCell value={f.expiresOn} mode="date" size="xs" dimmed />
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ whiteSpace: "nowrap" }}>
                  <DateCell value={f.lastModified} mode="relative" />
                </Table.Td>
                <Table.Td style={{ width: 1, whiteSpace: "nowrap" }}>{config.renderAction(f, { currentUserId, backTo, t })}</Table.Td>
              </Table.Tr>
            ))
          ) : !isError ? (
            <Table.Tr>
              <Table.Td colSpan={columnCount}>
                <EmptyState
                    icon={<IconMessages size={32} stroke={1.2} color="var(--mantine-color-dimmed)" />}
                    label={t("feedback.noFeedback")}
                    action={emptyAction}
                  />
              </Table.Td>
            </Table.Tr>
          ) : null}
        </Table.Tbody>
      </Table>

      <PaginationBar
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        rowsPerPageLabelKey="feedback.rowsPerPage"
      />
    </Stack>
  );
}
