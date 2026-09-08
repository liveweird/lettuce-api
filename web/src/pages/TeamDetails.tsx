import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconPlus,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { ApiError } from "../api/http";
import { getUserId, hasFeature, isAdmin } from "../api/session";
import { listAllUsers } from "../api/users";
import { addTeamMember, getTeam, removeTeamMember } from "../api/teams";
import { showSuccessToast } from "../utils/toast";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import EmptyState from "../components/EmptyState";
import TableLoadingRow from "../components/TableLoadingRow";
import RowActions from "../components/RowActions";
import { feedbackRowMenu } from "../components/feedbackActionsMenu";
import PersonaChip from "../components/PersonaChip";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import { renderUserOption, userOption } from "../components/userOptions";
import TeamMembersTable from "./TeamMembersTable";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { feedbackAskLink, feedbackProvideLink, userFeedbacksLink } from "../utils/feedbackLinks";
import { userDetailsLink } from "../utils/userLinks";
import { teamDetailsLink } from "../utils/teamLinks";
import { loadErrorMessage, saveErrorMessage } from "../utils/saveError";
import { useAllUsers } from "../hooks/useAllUsers";

type MemberRow = { id: number; name: string };

export default function TeamDetails() {
  const { t } = useTranslation();
  const params = useParams<{ id: string }>();
  // The org chart opens this page with ?from=org, My teams with ?from=myTeams — back links
  // return there instead of the teams list (the UserDetails origin idiom).
  const [searchParams] = useSearchParams();
  const fromParam = searchParams.get("from");
  const backTo = fromParam === "org" ? "/org" : fromParam === "myTeams" ? "/?tab=myTeams" : "/teams";
  const backLabel = t("feedback.backToLabel", {
    label: t(
      fromParam === "org"
        ? "feedback.origin.org"
        : fromParam === "myTeams"
          ? "dashboard.tabs.myTeams"
          : "teams.title",
    ),
  });
  const id = Number(params.id);
  const idIsValid = Number.isFinite(id) && id > 0;
  const queryClient = useQueryClient();
  // Non-admins get a read-only roster: no add picker, no remove buttons.
  const canManage = isAdmin();
  // Everyone may provide feedback for a member — except themselves (provider ≠ subject).
  const currentUserId = getUserId();

  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const {
    data: team,
    isLoading: teamLoading,
    isError: teamIsError,
    error: teamError,
  } = useQuery({
    queryKey: ["team", id],
    queryFn: () => getTeam(id),
    enabled: idIsValid,
    retry: false,
  });

  const {
    data: allMembers,
    isLoading: membersLoading,
    isError: membersIsError,
    error: membersError,
  } = useQuery({
    queryKey: ["teamMembersList", id],
    // ALL pages (the single-page-picker lesson, applied to the roster half too): a single
    // page of 100 would hide members 101+ from the roster AND wrongly offer them as addable.
    // Client-sorted by name below.
    queryFn: () => listAllUsers({ teamId: id }),
    enabled: idIsValid,
  });

  // The add-picker candidates come from the shared org-wide pool. Client-sorted by name below.
  const { userPool, usersError } = useAllUsers(idIsValid && canManage);

  const addMutation = useMutation({
    mutationFn: (userId: number) => addTeamMember(id, userId),
    onSuccess: async () => {
      setSelectedUser(null);
      setAddError(null);
      await queryClient.invalidateQueries({ queryKey: ["teamMembersList", id] });
      showSuccessToast(t("teams.toast.memberAdded"));
    },
    onError: (err) => {
      setAddError(
        saveErrorMessage(err, t, {
          forbidden: "teams.modifyForbidden",
          notFound: "teams.teamGone",
          invalid: "teams.addMemberInvalid",
          failedStatus: "teams.addFailedStatus",
          failed: "teams.addFailedNetwork",
        }),
      );
    },
  });

  const removeConfirm = useDeleteConfirm<MemberRow>({
    mutationFn: (row) => removeTeamMember(id, row.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teamMembersList", id] });
    },
    successMessage: t("teams.toast.memberRemoved"),
  });

  if (!idIsValid) return <Navigate to="/teams" replace />;

  const members = [...(allMembers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const memberIds = new Set(members.map((m) => m.id));
  const addOptions = (userPool ?? [])
    .filter((u) => !memberIds.has(u.id) && u.id !== team?.managerId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => userOption(u.id, u.name, (u.teams ?? []).map((teamRef) => teamRef.name)));

  function add() {
    if (selectedUser) addMutation.mutate(Number(selectedUser));
  }

  const teamNotFound = teamIsError && teamError instanceof ApiError && teamError.status === 404;

  // The adaptive body (v2.5.5): the team's current manager gets the subordinates card grid;
  // the roster renders for everyone else — and ALSO for an admin-manager (stacked), since
  // the roster is the app's only membership add/remove UI.
  const isManager = team != null && team.managerId === currentUserId;
  const showRoster = !isManager || canManage;
  // The grid's drill-down return target: this page with its own origin preserved, so the
  // Back-to round-trip (My teams / org chart) survives the detour.
  const backHere =
    fromParam === "org" || fromParam === "myTeams"
      ? `${teamDetailsLink(id)}?from=${fromParam}`
      : teamDetailsLink(id);

  if (teamLoading) {
    return (
      <Stack gap="md">
        <Title order={2}>{t("teams.detailsTitle")}</Title>
        <Center py="xl">
          <Loader />
        </Center>
      </Stack>
    );
  }

  if (teamNotFound || teamIsError) {
    return (
      <Stack gap="md">
        <Title order={2}>{t("teams.detailsTitle")}</Title>
        <Alert color="red" variant="light">
          {teamNotFound
            ? t("teams.teamNotFound")
            : t("teams.loadTeamFailed", {
                suffix: teamError instanceof ApiError ? ` (${teamError.status})` : "",
              })}
        </Alert>
        <Group justify="flex-end">
          <Button component={RouterLink} to={backTo} variant="default">
            {backLabel}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <PageHeader back={{ to: backTo, label: backLabel }} title={t("teams.detailsTitle")} />

      {/* The team's identity fields — the name, and the manager as the standard clickable
          persona (the v2.5.2 name-link idiom; deleted and one's own persona stay plain). */}
      {team && (
        <MetaStrip
          items={[
            { key: "name", label: t("common.field.name"), value: <Text size="sm">{team.name}</Text> },
            {
              key: "manager",
              label: t("common.field.manager"),
              value: team.managerDeleted ? (
                <Text size="sm" c="dimmed">
                  {team.managerName}
                  {t("teams.deletedSuffix")}
                </Text>
              ) : (
                <PersonaChip
                  name={team.managerName ?? ""}
                  to={
                    team.managerId !== currentUserId
                      ? userDetailsLink(team.managerId, team.managerName, "members", id)
                      : undefined
                  }
                  ariaLabel={t("users.detailsFor", { name: team.managerName })}
                />
              ),
            },
          ]}
        />
      )}

      {/* The team's manager sees their subordinates as the dashboard card grid (v2.5.5 —
          the former /teams/:id/subordinates view, merged here). An admin-manager gets the
          grid AND the roster-management section below (the roster is the only add/remove
          UI); everyone else gets the roster alone. */}
      {isManager && (
        <>
          <Title order={3}>{t("teams.subordinates")}</Title>
          <Text size="sm" c="dimmed">
            {t("dashboard.teamSubordinatesHint")}
          </Text>
          <TeamMembersTable
            view="managed"
            teamId={id}
            settingsKey="teamSubordinates"
            backTo={backHere}
            emptyMessage={t("dashboard.empty.teamMembers")}
          />
        </>
      )}

      {showRoster && (
        <>
      <Title order={3}>{t("teams.members")}</Title>

      {canManage && (
        <Group align="flex-end" gap="sm">
          <Select
            label={t("teams.addUser")}
            placeholder={t("teams.pickUser")}
            data={addOptions}
            renderOption={renderUserOption}
            value={selectedUser}
            onChange={setSelectedUser}
            searchable
            clearable
            nothingFoundMessage={t("teams.noUsersAvailable")}
            error={usersError ? t("common.error.optionsFailed") : undefined}
            w={280}
          />
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={add}
            disabled={!selectedUser}
            loading={addMutation.isPending}
          >
            {t("teams.add")}
          </Button>
        </Group>
      )}

      {canManage && addError && (
        <Alert color="red" variant="light" title={t("teams.addMemberFailed")} onClose={() => setAddError(null)} withCloseButton>
          {addError}
        </Alert>
      )}

      {membersIsError && (
        <Alert color="red" variant="light" title={t("teams.loadMembersFailed")}>
          {loadErrorMessage(membersError, t)}
        </Alert>
      )}

      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("common.field.name")}</Table.Th>
            <Table.Th>{t("common.field.email")}</Table.Th>
            <Table.Th aria-label={t("common.table.actions")} style={{ width: 1 }} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {membersLoading && !allMembers ? (
            <TableLoadingRow colSpan={3} />
          ) : members.length > 0 ? (
            members.map((m) => (
              <Table.Tr key={m.id}>
                <Table.Td style={{ maxWidth: 240 }}>
                  {/* The name links to the relationship-aware read-only card view — everyone,
                      except one's own row (the card flavors describe the viewer's relationship
                      to someone else); the members origin threads the teamId back here. */}
                  <PersonaChip
                    name={m.name}
                    to={m.id !== currentUserId ? userDetailsLink(m.id, m.name, "members", id) : undefined}
                    ariaLabel={t("users.detailsFor", { name: m.name })}
                  />
                </Table.Td>
                <Table.Td style={{ width: "100%", maxWidth: 0 }}>
                  <Text size="sm" truncate title={m.email}>
                    {m.email}
                  </Text>
                </Table.Td>
                <Table.Td style={{ width: 1, whiteSpace: "nowrap" }}>
                  <RowActions
                    name={m.name}
                    menus={
                      m.id !== currentUserId && hasFeature("FEEDBACKS")
                        ? [
                            feedbackRowMenu(t, {
                              provideTo: feedbackProvideLink(m.id),
                              askTo: feedbackAskLink(m.id, `/teams/${id}/details`),
                              listTo: userFeedbacksLink(m.id, m.name, "members", id),
                              name: m.name,
                            }),
                          ]
                        : []
                    }
                    items={
                      canManage
                        ? [
                            {
                              icon: <IconTrash size={14} />,
                              label: t("teams.remove"),
                              ariaLabel: t("teams.removeAria", { name: m.name }),
                              color: "red",
                              onClick: () => removeConfirm.requestDelete({ id: m.id, name: m.name }),
                            },
                          ]
                        : []
                    }
                  />
                </Table.Td>
              </Table.Tr>
            ))
          ) : !membersIsError ? (
            <Table.Tr>
              <Table.Td colSpan={3}>
                <EmptyState
                    icon={<IconUsers size={32} stroke={1.2} color="var(--mantine-color-dimmed)" />}
                    label={t("teams.noMembersYet")}
                  />
              </Table.Td>
            </Table.Tr>
          ) : null}
        </Table.Tbody>
      </Table>

      <Text size="sm" c="dimmed">
        {t("common.table.total", { count: members.length })}
      </Text>
        </>
      )}

      <ConfirmDeleteModal
        confirm={removeConfirm}
        title={t("teams.removeModalTitle")}
        errorTitle={t("teams.removeMemberFailed")}
        confirmLabel={t("teams.remove")}
        body={(row) => (
          <>
            {t("teams.removeConfirmLead")} <strong>{row.name}</strong>{" "}
            {t("teams.removeConfirmMid")} <strong>{team?.name}</strong>?
          </>
        )}
      />
    </Stack>
  );
}
