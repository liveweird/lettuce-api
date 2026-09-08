import { useMemo, useState } from "react";
import { Link as RouterLink, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  Alert,
  Anchor,
  Button,
  Container,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import EmojiTextarea from "../components/EmojiTextarea";
import { MAX_REQUESTER_MESSAGE_LENGTH } from "../utils/feedbackForm";
import { feedbackViewLink } from "../utils/feedbackLinks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconTrash, IconUserPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { getUserId, hasFeature } from "../api/session";
import { checkFeedbackDuplicate, createFeedback, type FeedbackVisibility } from "../api/feedbacks";
import DiscardGuard from "../components/DiscardGuard";
import EmptyState from "../components/EmptyState";
import FormFooter from "../components/FormFooter";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import PersonaChip from "../components/PersonaChip";
import { renderUserOption, userOption } from "../components/userOptions";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import { REQUESTER_VISIBILITIES } from "../utils/feedbackVisibility";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import { invalidateFeedback } from "../utils/feedbackQueries";
import { useAllUsers } from "../hooks/useAllUsers";
import { safeBackParam } from "../utils/url";

type Provider = { id: number; name: string };
const DEFAULT_VISIBILITY: FeedbackVisibility = "PROVIDER_REQUESTER_SUBJECT";

// The stable empty fallback for the duplicate probe — a fresh Map per render would defeat
// memo/equality checks downstream.
const NO_DUPLICATES: ReadonlyMap<number, { existingId?: number | null; existingStatus?: string | null }> =
  new Map();

export default function RequestFeedback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const visibilityOptions = REQUESTER_VISIBILITIES.map((value) => ({
    value,
    label: t(`common.visibility.${value}`),
  }));

  const subjectId = Number(searchParams.get("subjectId"));
  // Return to the Dashboard tab the user came from; default to subordinates.
  const backTo = safeBackParam(searchParams) ?? "/?tab=subordinates";
  const requesterId = getUserId();

  const [selected, setSelected] = useState<Provider[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<FeedbackVisibility>(DEFAULT_VISIBILITY);
  const [message, setMessage] = useState("");
  // A failed submit round: how many requests went out, and per failed provider the reason.
  // The succeeded providers leave the list, so a resubmit retries exactly the failures.
  const [partial, setPartial] = useState<{
    sent: number;
    total: number;
    failures: { name: string; reason: string }[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The one cancel guard (v3.5.0): picked providers, a typed note, or a changed visibility.
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: selected.length > 0 || message !== "" || visibility !== DEFAULT_VISIBILITY,
    to: backTo,
    title: t("feedback.discardRequestTitle"),
    message: t("feedback.discardRequestMessage"),
  });

  const { userPool, usersError, usersReady } = useAllUsers();

  const subjectIdIsValid = Number.isFinite(subjectId) && subjectId > 0;
  // The subject's display name resolves from the org pool — never from a URL param (v2.35.0);
  // an id matching no user bounces back once the pool settles.
  const subject = subjectIdIsValid ? (userPool ?? []).find((u) => u.id === subjectId) : undefined;

  // Early no-duplicate check, one triple per picked provider: providers whose feedback is
  // already in progress get an inline warning with a link, and Request stays disabled until
  // they are removed (the server would 409 anyway).
  const selectedIds = selected.map((p) => p.id).sort((a, b) => a - b);
  const { data: duplicateData } = useQuery({
    queryKey: ["feedbackDuplicate", "request", subjectId, requesterId, selectedIds.join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        selectedIds.map(async (providerId) => {
          const result = await checkFeedbackDuplicate({
            subjectId,
            providerId,
            requesterId: requesterId!,
          });
          return [providerId, result] as const;
        }),
      );
      return new Map(entries.filter(([, r]) => r.existingId != null));
    },
    enabled: subjectIdIsValid && requesterId != null && selectedIds.length > 0,
  });
  const duplicates = duplicateData ?? NO_DUPLICATES;
  const hasDuplicates = selected.some((p) => duplicates.has(p.id));

  // A provider cannot be the requester (requester ≠ provider), cannot be the subject
  // (provider ≠ subject since v2.36.0 — requesting a self-reflection is gone with the
  // feature), and cannot be already chosen.
  const addOptions = useMemo(() => {
    const chosen = new Set(selected.map((p) => p.id));
    return (userPool ?? [])
      .filter((u) => u.id !== requesterId && u.id !== subjectId && !chosen.has(u.id))
      .map((u) => userOption(u.id, u.name, (u.teams ?? []).map((team) => team.name)))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [userPool, selected, requesterId, subjectId]);

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("FEEDBACKS")) return <Navigate to="/" replace />;
  if (!subjectIdIsValid || requesterId == null) return <Navigate to={backTo} replace />;
  if (usersReady && !subject) return <Navigate to={backTo} replace />;

  function add() {
    if (!pick) return;
    const id = Number(pick);
    const user = (userPool ?? []).find((u) => u.id === id);
    if (!user) return;
    setSelected((prev) => (prev.some((p) => p.id === id) ? prev : [...prev, { id, name: user.name }]));
    setPick(null);
  }

  function remove(id: number) {
    setSelected((prev) => prev.filter((p) => p.id !== id));
  }

  async function submit() {
    if (selected.length === 0) return;
    setPartial(null);
    setSubmitting(true);
    // One create per provider, SEQUENTIALLY with per-provider outcomes (v2.24.0 — the old
    // Promise.all short-circuited on the first rejection, hiding which requests were already
    // created and 409-ing the survivors on resubmit). Successes leave the list immediately.
    const failures: { provider: Provider; err: unknown }[] = [];
    for (const p of selected) {
      try {
        await createFeedback({
          requesterId: requesterId!,
          subjectId,
          providerId: p.id,
          visibility,
          status: "REQUESTED",
          content: "",
          requesterMessage: message.trim() || undefined,
        });
      } catch (err) {
        failures.push({ provider: p, err });
      }
    }
    await invalidateFeedback(queryClient);
    setSubmitting(false);
    if (failures.length === 0) {
      showSuccessToast(t("feedback.toast.requested"));
      navigate(backTo, { replace: true });
      return;
    }
    // Keep only the failed providers selected (the duplicate probe re-checks them too), and
    // name each failure with its reason.
    setSelected(failures.map((f) => f.provider));
    setPartial({
      sent: selected.length - failures.length,
      total: selected.length,
      failures: failures.map((f) => ({
        name: f.provider.name,
        reason: saveErrorMessage(f.err, t, {
          forbidden: "feedback.error.requestPermission",
          conflict: "feedback.error.duplicate",
          invalid: "feedback.error.validationProviders",
          failedStatus: "feedback.error.requestFailedStatus",
          failed: "feedback.error.requestFailed",
        }),
      })),
    });
  }

  return (
    <>
      <PageHeader title={t("feedback.requestFeedbackTitle")} mb="lg" />
      <Container size="md" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          <Stack>
            {/* The context line (v3.5.0): about whom, asked by whom. */}
            <MetaStrip
              items={[
                {
                  key: "subject",
                  label: t("common.field.subject"),
                  value:
                    subjectId === requesterId ? (
                      <Text size="sm">{t("common.state.you")}</Text>
                    ) : (
                      <PersonaChip name={subject?.name ?? `#${subjectId}`} />
                    ),
                },
                {
                  key: "requester",
                  label: t("common.field.requester"),
                  value: <Text size="sm">{t("common.state.you")}</Text>,
                },
              ]}
            />

            <Select
              label={t("common.field.visibility")}
              placeholder={t("feedback.selectVisibility")}
              data={visibilityOptions}
              allowDeselect={false}
              value={visibility}
              onChange={(v) => v && setVisibility(v as FeedbackVisibility)}
            />

            <EmojiTextarea
              label={t("feedback.requesterMessageLabel")}
              placeholder={t("feedback.requesterMessagePlaceholder")}
              value={message}
              onChange={setMessage}
              maxLength={MAX_REQUESTER_MESSAGE_LENGTH}
              autosize
              minRows={2}
              maxRows={6}
            />

            <Group align="flex-end" gap="sm">
              <Select
                label={t("feedback.addProvider")}
                placeholder={t("feedback.pickUser")}
                data={addOptions}
                renderOption={renderUserOption}
                value={pick}
                onChange={setPick}
                searchable
                clearable
                nothingFoundMessage={t("feedback.noUsersAvailable")}
                error={usersError ? t("common.error.optionsFailed") : undefined}
                w={280}
              />
              <Button leftSection={<IconPlus size={16} />} onClick={add} disabled={!pick}>
                {t("feedback.add")}
              </Button>
            </Group>

            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("common.field.provider")}</Table.Th>
                  <Table.Th aria-label={t("common.table.actions")} style={{ width: 1 }} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {selected.length > 0 ? (
                  selected.map((p) => {
                    const dup = duplicates.get(p.id);
                    return (
                      <Table.Tr key={p.id}>
                        <Table.Td>
                          <PersonaChip name={p.name} />
                          {dup?.existingId != null && (
                            <Text size="xs" c="orange.8" mt={4}>
                              {dup.existingStatus === "DRAFT"
                                ? t("feedback.duplicate.draft")
                                : t("feedback.duplicate.requested")}{" "}
                              <Anchor
                                component={RouterLink}
                                to={feedbackViewLink(dup.existingId)}
                                size="xs"
                                fw={600}
                                c="var(--lettuce-ink-warning)"
                              >
                                {t("feedback.duplicate.open")}
                              </Anchor>
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Button
                            color="red"
                            variant="subtle"
                            size="xs"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => remove(p.id)}
                            aria-label={t("feedback.removeName", { name: p.name })}
                          >
                            {t("feedback.remove")}
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })
                ) : (
                  <Table.Tr>
                    <Table.Td colSpan={2}>
                      <EmptyState
                          icon={<IconUserPlus size={32} stroke={1.2} color="var(--mantine-color-dimmed)" />}
                          label={t("feedback.addAtLeastOneProvider")}
                        />
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>

            {partial && (
              <Alert
                color="red"
                variant="light"
                title={t("feedback.error.requestPartial", { sent: partial.sent, total: partial.total })}
              >
                <Stack gap={2}>
                  {partial.failures.map((f) => (
                    <Text key={f.name} size="sm">
                      {`${f.name} — ${f.reason}`}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}

            <FormFooter>
              <Button type="button" variant="default" onClick={requestCancel} disabled={submitting}>
                {t("common.action.cancel")}
              </Button>
              <Button
                type="button"
                onClick={submit}
                loading={submitting}
                disabled={selected.length === 0 || hasDuplicates}
              >
                {t("feedback.action.request")}
              </Button>
            </FormFooter>
          </Stack>
        </Paper>
      </Container>

      <DiscardGuard {...guardProps} />
    </>
  );
}
