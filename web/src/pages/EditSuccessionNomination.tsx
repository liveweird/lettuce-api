import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Center,
  Container,
  Fieldset,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useForm, type UseFormReturnType } from "@mantine/form";
import { IconPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { hasFeature } from "../api/session";
import { createGoal, listGoals, type GoalListItem } from "../api/goals";
import {
  createSuccessionNomination,
  getSuccessionPlan,
  updateSuccessionNomination,
  type CandidateAwareness,
  type NominationType,
  type SuccessionNominationResponse,
  type SuccessionPlanResponse,
  type SuccessorReadiness,
} from "../api/successionPlans";
import ConfirmActionModal from "../components/ConfirmActionModal";
import DiscardGuard from "../components/DiscardGuard";
import FormFooter from "../components/FormFooter";
import GoalDefinitionFields from "../components/GoalDefinitionFields";
import MetaStrip from "../components/MetaStrip";
import OrderedTextListEditor from "../components/OrderedTextListEditor";
import PageHeader from "../components/PageHeader";
import PersonaChip from "../components/PersonaChip";
import { renderUserOption, userOption, type UserOption } from "../components/userOptions";
import { useAllUsers } from "../hooks/useAllUsers";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import { useManagedReports } from "../hooks/useManagedReports";
import {
  goalDefinitionValidation,
  toDefinitionBody,
  type GoalDefinitionFormValues,
} from "../utils/goalForm";
import { invalidateGoal } from "../utils/goalQueries";
import {
  emptyNominationValues,
  emptyTextRowDraft,
  nominationValidation,
  successionLoadErrorMessage,
  successionSaveErrorMessage,
  toNominationBody,
  toNominationFormValues,
  type SuccessionNominationFormValues,
} from "../utils/successionForm";
import { successionPlanViewLink } from "../utils/successionLinks";
import { invalidateSuccession } from "../utils/successionQueries";
import { showSuccessToast } from "../utils/toast";
import { safeBackParam } from "../utils/url";

const READINESS: readonly SuccessorReadiness[] = [
  "READY_NOW",
  "READY_SOON",
  "FUTURE_PIPELINE",
  "EMERGENCY_INTERIM",
];
const TYPES: readonly NominationType[] = ["PRIMARY", "SECONDARY", "CROSS_TEAM"];
const AWARENESS: readonly CandidateAwareness[] = ["TRANSPARENT", "IMPLICIT", "CONFIDENTIAL"];

const EMPTY_GOAL_VALUES: GoalDefinitionFormValues = {
  title: "",
  description: "",
  type: "NUMBER",
  targetValue: "",
  targetDirection: "AT_LEAST",
  milestones: [],
  dueDate: "",
};

type SelectOption = { value: string; label: string };

// Any active user except the seat's person; candidates already on the bench would 409, so
// they drop out too (the edited nomination keeps its own candidate pickable).
function buildCandidateOptions(
  plan: SuccessionPlanResponse | undefined,
  userPool: ReturnType<typeof useAllUsers>["userPool"],
  nominationId: number | null,
): UserOption[] {
  if (plan == null) return [];
  const taken = new Set(
    plan.nominations
      .filter((nomination) => nomination.id !== nominationId)
      .map((nomination) => nomination.candidateId),
  );
  // The edited nomination's OWN candidate stays pickable even if since deactivated — the
  // server allows keeping them (the delta rule), and dropping the option would blank the
  // Select while the form silently resubmits the id (checkup-29).
  const keepId = plan.nominations.find((n) => n.id === nominationId)?.candidateId;
  return (userPool ?? [])
    .filter((u) => u.id !== plan.userId && (!u.deactivated || u.id === keepId) && !taken.has(u.id))
    .map((u) => userOption(u.id, u.name, (u.teams ?? []).map((team) => team.name)));
}

// The linkable pool plus any already-linked goals outside it (e.g. another chain manager's) —
// kept selectable so a save doesn't silently drop them.
function buildGoalOptions(
  poolItems: GoalListItem[],
  existingGoals: SuccessionNominationResponse["goals"],
  t: TFunction,
): SelectOption[] {
  const fromPool = poolItems.map((goal) => ({
    value: String(goal.id),
    label: `${goal.title} (${t(`goal.status.${goal.status}`)})`,
  }));
  const known = new Set(fromPool.map((option) => option.value));
  const extras = existingGoals
    .filter((goal) => !known.has(String(goal.id)))
    .map((goal) => ({
      value: String(goal.id),
      label: `${goal.title} (${t(`goal.status.${goal.status}`)})`,
    }));
  return [...fromPool, ...extras];
}

/**
 * The inline development-goal create (linked by default): a modal so the nomination form
 * keeps its state — the created goal lands as a DRAFT of the candidate and is handed back
 * to the caller for immediate selection. Split out of the page function for cognitive-
 * complexity budget as much as cohesion.
 */
function DevelopmentGoalModal({
  opened,
  onClose,
  candidateId,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  candidateId: number | null;
  onCreated: (goalId: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [goalError, setGoalError] = useState<string | null>(null);
  const [goalSubmitting, setGoalSubmitting] = useState(false);
  const goalForm = useForm<GoalDefinitionFormValues>({
    initialValues: EMPTY_GOAL_VALUES,
    validate: goalDefinitionValidation(t),
  });

  async function createDevelopmentGoal(values: GoalDefinitionFormValues) {
    if (candidateId == null) return;
    setGoalError(null);
    setGoalSubmitting(true);
    try {
      const created = await createGoal({ subordinateId: candidateId, ...toDefinitionBody(values) });
      await invalidateGoal(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["succession", "linkableGoals", candidateId] });
      showSuccessToast(t("succession.toast.goalCreated"));
      // Linked by default: the fresh DRAFT joins the selection immediately.
      onCreated(String(created.id));
      goalForm.reset();
      onClose();
    } catch (err) {
      setGoalError(successionSaveErrorMessage(err, t));
    } finally {
      setGoalSubmitting(false);
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (goalSubmitting) return;
        // Stale half-typed input must not resurface on the next open (checkup-29).
        goalForm.reset();
        onClose();
      }}
      title={t("succession.newGoalTitle")}
      size="lg"
    >
      <form onSubmit={goalForm.onSubmit(createDevelopmentGoal)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t("succession.newGoalHint")}
          </Text>
          <GoalDefinitionFields form={goalForm} />
          {goalError && (
            <Alert color="red" variant="light">
              {goalError}
            </Alert>
          )}
          <FormFooter>
            <Button
              type="button"
              variant="default"
              onClick={() => {
                goalForm.reset();
                onClose();
              }}
              disabled={goalSubmitting}
            >
              {t("common.action.cancel")}
            </Button>
            <Button type="submit" loading={goalSubmitting}>
              {t("common.action.create")}
            </Button>
          </FormFooter>
        </Stack>
      </form>
    </Modal>
  );
}

/** The nomination form proper — split out of the page for cognitive-complexity budget. */
function NominationForm({
  form,
  seatName,
  candidateOptions,
  goalOptions,
  usersError,
  goalsError,
  candidateId,
  canCreateGoal,
  submitting,
  editing,
  error,
  onSubmit,
  onCancel,
  onOpenGoalModal,
}: {
  form: UseFormReturnType<SuccessionNominationFormValues>;
  seatName: string;
  candidateOptions: UserOption[];
  goalOptions: SelectOption[];
  usersError: boolean;
  goalsError: boolean;
  candidateId: number | null;
  canCreateGoal: boolean;
  submitting: boolean;
  editing: boolean;
  error: string | null;
  onSubmit: (values: SuccessionNominationFormValues) => void;
  onCancel: () => void;
  onOpenGoalModal: () => void;
}) {
  const { t } = useTranslation();
  return (
    <form onSubmit={form.onSubmit(onSubmit)} noValidate>
      <Stack>
        {/* The seat's context line (v3.5.0) — the person never changes on this screen. */}
        <MetaStrip
          items={[{ key: "person", label: t("succession.person"), value: <PersonaChip name={seatName} /> }]}
        />

        <Fieldset legend={t("succession.section.candidate")}>
          <Stack>
            <Select
              label={t("succession.candidate")}
              placeholder={t("succession.pickCandidate")}
              data={candidateOptions}
              renderOption={renderUserOption}
              searchable
              clearable
              nothingFoundMessage={t("succession.noCandidates")}
              {...form.getInputProps("candidateId")}
              error={
                usersError ? t("common.error.optionsFailed") : form.errors.candidateId
              }
            />
            <Group gap="xl" align="flex-start">
              <Select
                label={t("succession.readinessLabel")}
                data={READINESS.map((value) => ({
                  value,
                  label: t(`succession.readiness.${value}`),
                }))}
                allowDeselect={false}
                w={230}
                {...form.getInputProps("readiness")}
              />
              <Select
                label={t("succession.nominationTypeLabel")}
                data={TYPES.map((value) => ({
                  value,
                  label: t(`succession.nominationType.${value}`),
                }))}
                allowDeselect={false}
                w={200}
                {...form.getInputProps("nominationType")}
              />
              <Select
                label={t("succession.awarenessLabel")}
                data={AWARENESS.map((value) => ({
                  value,
                  label: t(`succession.awareness.${value}`),
                }))}
                allowDeselect={false}
                w={200}
                {...form.getInputProps("awareness")}
              />
            </Group>
          </Stack>
        </Fieldset>

        {/* The legend names the list — the editor renders without its own label. */}
        <Fieldset legend={t("succession.section.competencyGaps")}>
          <OrderedTextListEditor
            form={form}
            field="competencyGaps"
            onAdd={() => form.insertListItem("competencyGaps", emptyTextRowDraft())}
            emptyLabel={t("succession.noCompetencyGaps")}
            addLabel={t("succession.addCompetencyGap")}
            rowAria={{
              item: (position) => t("succession.competencyGapAria", { position }),
              moveUp: (position) => t("succession.competencyGapMoveUp", { position }),
              moveDown: (position) => t("succession.competencyGapMoveDown", { position }),
              remove: (position) => t("succession.competencyGapRemove", { position }),
            }}
            flag={{ aria: (position) => t("succession.competencyGapFilledAria", { position }) }}
          />
        </Fieldset>

        <Fieldset legend={t("succession.section.goals")}>
          <Stack gap={6}>
            <MultiSelect
              label={t("succession.developmentGoals")}
              description={t("succession.developmentGoalsHint")}
              placeholder={candidateId == null ? t("succession.pickCandidateFirst") : undefined}
              data={goalOptions}
              searchable
              disabled={candidateId == null}
              error={goalsError ? t("common.error.optionsFailed") : undefined}
              {...form.getInputProps("goalIds")}
            />
            {canCreateGoal && (
              <Group>
                <Button
                  type="button"
                  variant="light"
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  onClick={onOpenGoalModal}
                >
                  {t("succession.newGoal")}
                </Button>
              </Group>
            )}
          </Stack>
        </Fieldset>

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <FormFooter sticky>
          <Button type="button" variant="default" onClick={onCancel} disabled={submitting}>
            {t("common.action.cancel")}
          </Button>
          <Button type="submit" loading={submitting} disabled={candidateId == null}>
            {editing ? t("common.action.save") : t("common.action.create")}
          </Button>
        </FormFooter>
      </Stack>
    </form>
  );
}

/**
 * The nomination editor — one screen for both create (`/succession/:id/nominations/new`) and
 * edit (`…/:nominationId/edit`), the whole-document PUT convention. Candidates come from the
 * org-wide pool (any active user except the seat's person — cross-team/lateral nominations
 * are expected); the development action items are the candidate's existing goals the caller
 * may link, plus a "New development goal" modal (linked by default) when the candidate is in
 * the caller's own chain (the server would 403 a goal create for anyone else).
 */
export default function EditSuccessionNomination() {
  const { t } = useTranslation();
  const params = useParams<{ id: string; nominationId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const planId = Number(params.id);
  const planIdIsValid = Number.isFinite(planId) && planId > 0;
  const nominationId = params.nominationId != null ? Number(params.nominationId) : null;
  const editing = nominationId != null;
  const backTo =
    safeBackParam(searchParams) ?? (planIdIsValid ? successionPlanViewLink(planId) : "/succession");

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [goalModalOpen, { open: openGoalModal, close: closeGoalModal }] = useDisclosure(false);
  const [primaryConfirmOpen, { open: openPrimaryConfirm, close: closePrimaryConfirm }] =
    useDisclosure(false);
  const [pendingValues, setPendingValues] = useState<SuccessionNominationFormValues | null>(null);

  const { data: plan, isLoading, isError, error: fetchError } = useQuery({
    queryKey: ["successionPlan", planId],
    queryFn: () => getSuccessionPlan(planId),
    enabled: planIdIsValid,
    retry: false,
  });

  const form = useForm<SuccessionNominationFormValues>({
    initialValues: emptyNominationValues(),
    validate: nominationValidation(t),
  });
  // Payload-compared dirtiness (form.isDirty() misses list ops once a field was reverted —
  // checkup-29): the same body the save sends, against the seeded initial values.
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: () =>
      JSON.stringify(toNominationBody(form.values)) !==
      JSON.stringify(toNominationBody(form.getInitialValues())),
    to: backTo,
    title: t("succession.discardChangesTitle"),
    message: t("succession.discardChangesMessage"),
  });

  const existing = editing
    ? plan?.nominations.find((nomination) => nomination.id === nominationId)
    : undefined;

  // One-shot: seed the form once the edited nomination arrives (initialize no-ops afterwards).
  if (existing && !form.initialized) {
    form.initialize(toNominationFormValues(existing));
  }
  // Create mode seeds SECONDARY when the plan already holds a PRIMARY, so the confirm-demote
  // flow below fires only on a deliberate choice — not on every second nomination.
  if (!editing && plan && !form.initialized) {
    form.initialize({
      ...emptyNominationValues(),
      nominationType: plan.nominations.some((nomination) => nomination.nominationType === "PRIMARY")
        ? "SECONDARY"
        : "PRIMARY",
    });
  }

  // The one-PRIMARY-per-plan rule (V69): the server demotes this nomination's rival to
  // SECONDARY in the same write, so a submit that sets PRIMARY beside it must be confirmed.
  const otherPrimary = plan?.nominations.find(
    (nomination) => nomination.nominationType === "PRIMARY" && nomination.id !== nominationId,
  );

  const { userPool, usersError } = useAllUsers();
  const { reports } = useManagedReports(true);

  const candidateId = form.values.candidateId != null ? Number(form.values.candidateId) : null;

  const candidateOptions = useMemo(
    () => buildCandidateOptions(plan, userPool, nominationId),
    [plan, userPool, nominationId],
  );

  // The linkable development goals: the candidate's goals the caller set (any status) or the
  // chain set (non-DRAFT) — exactly the pool the server accepts links from.
  const { data: linkableGoals, isError: goalsError } = useQuery({
    queryKey: ["succession", "linkableGoals", candidateId],
    queryFn: () =>
      listGoals({
        view: "managed",
        subordinateId: candidateId!,
        includeIndirect: true,
        page: 1,
        pageSize: 100,
        sort: "title",
      }),
    enabled: candidateId != null,
  });
  const goalOptions = useMemo(
    () => buildGoalOptions(linkableGoals?.items ?? [], existing?.goals ?? [], t),
    [linkableGoals, existing, t],
  );

  // The goal-create modal only makes sense for candidates in the caller's own chain.
  const canCreateGoal =
    candidateId != null && reports.some((report) => report.userId === candidateId);

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("SUCCESSION_PLANS")) return <Navigate to="/" replace />;
  if (!planIdIsValid || (editing && !(Number.isFinite(nominationId) && nominationId! > 0))) {
    return <Navigate to="/succession" replace />;
  }

  const loadErrorText = successionLoadErrorMessage(fetchError, t);
  const closed = plan != null && plan.status !== "OPEN";
  const missingNomination = editing && plan != null && existing == null;

  async function save(values: SuccessionNominationFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      const body = toNominationBody(values);
      if (editing) {
        await updateSuccessionNomination(planId, nominationId!, body);
        showSuccessToast(t("succession.toast.nominationUpdated"));
      } else {
        await createSuccessionNomination(planId, body);
        showSuccessToast(t("succession.toast.nominationCreated"));
      }
      await invalidateSuccession(queryClient, planId);
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(successionSaveErrorMessage(err, t));
      setSubmitting(false);
    }
  }

  function handleSubmit(values: SuccessionNominationFormValues) {
    if (values.nominationType === "PRIMARY" && otherPrimary) {
      setPendingValues(values);
      openPrimaryConfirm();
      return;
    }
    void save(values);
  }

  const pendingCandidateName =
    candidateOptions.find((option) => option.value === pendingValues?.candidateId)?.label ?? "";

  return (
    <>
      <PageHeader
        title={editing ? t("succession.editNominationTitle") : t("succession.addNominationTitle")}
        description={t("succession.nominationHint")}
        mb="lg"
      />
      <Container size="md" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : isError || closed || missingNomination ? (
            <Stack>
              <Alert color="red" variant="light">
                {isError
                  ? loadErrorText
                  : closed
                    ? t("succession.closedNote")
                    : t("succession.error.nominationNotFound")}
              </Alert>
              <FormFooter>
                <Button type="button" variant="default" onClick={() => navigate(backTo)}>
                  {t("common.action.close")}
                </Button>
              </FormFooter>
            </Stack>
          ) : plan ? (
            <NominationForm
              form={form}
              seatName={plan.userName}
              candidateOptions={candidateOptions}
              goalOptions={goalOptions}
              usersError={usersError}
              goalsError={goalsError}
              candidateId={candidateId}
              canCreateGoal={canCreateGoal}
              submitting={submitting}
              editing={editing}
              error={error}
              onSubmit={handleSubmit}
              onCancel={requestCancel}
              onOpenGoalModal={openGoalModal}
            />
          ) : null}
        </Paper>
      </Container>

      <DevelopmentGoalModal
        opened={goalModalOpen}
        onClose={closeGoalModal}
        candidateId={candidateId}
        onCreated={(goalId) => form.setFieldValue("goalIds", [...form.values.goalIds, goalId])}
      />

      <ConfirmActionModal
        opened={primaryConfirmOpen}
        onClose={closePrimaryConfirm}
        title={t("succession.primaryConfirmTitle")}
        message={t("succession.primaryConfirmMessage", {
          candidate: pendingCandidateName,
          current: otherPrimary?.candidateName ?? "",
        })}
        cancelLabel={t("common.action.cancel")}
        confirmLabel={t("succession.primaryConfirmAction")}
        confirmColor="lettuce"
        onConfirm={() => {
          // Close first — a failed save reports through the form's inline Alert, not a modal.
          closePrimaryConfirm();
          if (pendingValues) void save(pendingValues);
        }}
      />

      <DiscardGuard {...guardProps} />
    </>
  );
}
