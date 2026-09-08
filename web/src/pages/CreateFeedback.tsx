import { useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Stack } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getUserId, hasFeature } from "../api/session";
import { createFeedback, type FeedbackStatus, type FeedbackVisibility } from "../api/feedbacks";
import { invalidateFeedback } from "../utils/feedbackQueries";
import DuplicateFeedbackAlert from "../components/DuplicateFeedbackAlert";
import FeedbackForm from "../components/FeedbackForm";
import RecipientsMultiSelect from "../components/RecipientsMultiSelect";
import { userOption } from "../components/userOptions";
import { useAllUsers } from "../hooks/useAllUsers";
import { useFeedbackDuplicates } from "../hooks/useFeedbackDuplicate";
import { feedbackEditLink } from "../utils/feedbackLinks";
import { saveErrorMessage } from "../utils/saveError";
import { PROVIDE_ERROR_KEYS } from "../utils/feedbackForm";
import { showSuccessToast } from "../utils/toast";
import { safeBackParam } from "../utils/url";

/**
 * The feedback create screen, also serving the Kudos wall's create flow (`/kudos/new` renders
 * it with `kudo` — formerly the separate CreateKudo page, folded in the 2026-08 review round):
 * kudo mode always shows the recipient picker, pins Visibility to PUBLIC (shown read-only),
 * and returns to the wall. The result is an ordinary feedback either way: a kudo draft lives
 * under "Provided" like any other and reaches the wall once sent.
 */
export default function CreateFeedback({ kudo = false }: { kudo?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<FeedbackStatus | null>(null);
  // Picker mode's recipients, in pick order (the MultiSelect contract: ids as strings). The
  // raw picks are filtered against the live pool below, so a pick whose user has since left
  // the pool (deactivated/deleted between refetches) vanishes instead of lingering as a raw-id
  // pill the server would reject.
  const [rawPicks, setRawPicks] = useState<string[]>([]);

  const urlSubjectId = Number(searchParams.get("subjectId"));
  // An explicit `back` (e.g. the per-manager feedbacks screen) overrides the default return
  // to "/" — sanitized (in-app path only); kudo mode always returns to the wall (its entry
  // point carries no back param).
  const backTo = kudo ? "/kudos" : (safeBackParam(searchParams) ?? "/");
  const providerId = getUserId();

  // Two modes (v2.28.0): a valid subjectId in the URL fixes the subject (the deep-link path —
  // users-row actions, person cards; exactly ONE recipient, no adding); without one the page
  // renders the recipient picker instead of redirecting (the /feedback header's "New feedback"
  // entry) — since v3.1.0 a MultiSelect for up to four people. Kudo mode is always the picker
  // — the wall has no per-person entry point. The pool ALWAYS loads (v2.35.0): a URL-carried
  // subject resolves its display name against it — never from a URL param — and an id
  // matching no user falls back to the picker once the pool settles.
  const urlSubjectRequested = !kudo && Number.isFinite(urlSubjectId) && urlSubjectId > 0;
  const { userPool, usersError, usersReady } = useAllUsers(true);
  // A URL-crafted SELF subject resolves to nothing (feedback about yourself is gone since
  // v2.36.0 — the server rejects it), so it falls back to the picker like any unknown id.
  const urlSubject = urlSubjectRequested
    ? (userPool ?? []).find((u) => u.id === urlSubjectId && u.id !== providerId)
    : undefined;
  const pickerMode = !urlSubjectRequested || (usersReady && !urlSubject);

  // Picking praises/reviews OTHERS: the caller is excluded — feedback about yourself is not
  // supported (the self-reflection feature was retired in v2.36.0; the Impact log replaces it).
  const subjectOptions = useMemo(
    () =>
      (userPool ?? [])
        .filter((u) => u.id !== providerId)
        .map((u) => userOption(u.id, u.name, (u.teams ?? []).map((team) => team.name)))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [userPool, providerId],
  );
  const subjectPicks = useMemo(
    () => (usersReady ? rawPicks.filter((p) => subjectOptions.some((o) => o.value === p)) : rawPicks),
    [usersReady, rawPicks, subjectOptions],
  );
  const subjectIds: number[] = urlSubject
    ? [urlSubject.id]
    : pickerMode
      ? subjectPicks.map(Number)
      : [];

  // Warn about in-progress duplicates before the user types anything — one probe per picked
  // recipient (the rule is per recipient: an open draft naming ANY of them blocks the create).
  // Hook order: before the redirect early-return.
  const duplicates = useFeedbackDuplicates(subjectIds, providerId);

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("FEEDBACKS")) return <Navigate to="/" replace />;
  if (providerId == null) return <Navigate to="/" replace />;

  const nameOf = (id: number) => (userPool ?? []).find((u) => u.id === id)?.name;
  const subjects = !pickerMode
    ? // The `#id` placeholder shows only until the pool resolves the canonical name.
      [{ display: urlSubject?.name ?? `#${urlSubjectId}` }]
    : subjectIds.map((id) => ({ display: nameOf(id) ?? `#${id}` }));
  const duplicateHits = duplicates.filter((d) => d.result.existingId != null);

  async function submit(
    status: FeedbackStatus,
    values: { visibility: FeedbackVisibility; content: string },
  ) {
    if (subjectIds.length === 0) return;
    setError(null);
    setSubmitting(status);
    try {
      const [subjectId, ...additionalSubjectIds] = subjectIds;
      await createFeedback({
        subjectId,
        ...(additionalSubjectIds.length > 0 ? { additionalSubjectIds } : {}),
        providerId: providerId!,
        // Kudo mode pins PUBLIC — `values.visibility` is PUBLIC too (read-only), but the
        // contract of that screen is explicit.
        visibility: kudo ? "PUBLIC" : values.visibility,
        status,
        content: values.content,
      });
      await invalidateFeedback(queryClient);
      showSuccessToast(t(status === "SENT" ? "feedback.toast.sent" : "feedback.toast.draftSaved"));
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(
        saveErrorMessage(err, t, PROVIDE_ERROR_KEYS),
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <FeedbackForm
      // The creation-verb convention: each entry point's screen reuses its entry button's
      // wording ("New kudo" / "New feedback"); a deep link with a fixed subject keeps
      // "Provide feedback".
      title={kudo ? t("kudos.createTitle") : pickerMode ? t("feedback.newFeedback") : t("feedback.provideTitle")}
      subjects={subjects}
      initialVisibility={kudo ? "PUBLIC" : "PROVIDER_SUBJECT"}
      initialContent=""
      submitting={submitting}
      error={error}
      onSubmit={submit}
      cancelTo={backTo}
      // Picks live outside the editor form — Cancel guards them like typed content.
      parentDirty={pickerMode && subjectPicks.length > 0}
      showTemplateInsert
      discardTitle={t("feedback.discardCreateTitle")}
      discardMessage={t("feedback.discardCreateMessage")}
      subjectControl={
        pickerMode ? (
          <RecipientsMultiSelect
            label={kudo ? t("kudos.recipientsLabel") : t("feedback.recipientsLabel")}
            options={subjectOptions}
            value={subjectPicks}
            onChange={setRawPicks}
            error={usersError ? t("common.error.optionsFailed") : undefined}
          />
        ) : undefined
      }
      visibilityReadOnly={kudo}
      submitDisabled={subjectIds.length === 0}
      duplicate={
        duplicateHits.length > 0 ? (
          <Stack gap="xs">
            {duplicateHits.map(({ subjectId, result }) => (
              // The caller is the provider, so the edit route (or its triage screen) is theirs.
              <DuplicateFeedbackAlert
                key={subjectId}
                status={result.existingStatus ?? "DRAFT"}
                to={feedbackEditLink(result.existingId!)}
                recipientName={pickerMode ? (nameOf(subjectId) ?? `#${subjectId}`) : undefined}
              />
            ))}
          </Stack>
        ) : undefined
      }
    />
  );
}
