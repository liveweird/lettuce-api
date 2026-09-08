import { useState } from "react";
import {
  Link as RouterLink,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Alert, Button, Center, Container, Loader, Paper, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { getUserId, hasFeature } from "../api/session";
import { subjectDisplays } from "../utils/feedbackSubjects";
import { deleteFeedback, getFeedback, pickUpFeedback, rejectFeedback, sendFeedback, updateFeedback, type FeedbackStatus, type FeedbackVisibility } from "../api/feedbacks";
import ConfirmActionModal from "../components/ConfirmActionModal";
import DateCell from "../components/DateCell";
import FeedbackForm from "../components/FeedbackForm";
import FormFooter from "../components/FormFooter";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import PersonaChip from "../components/PersonaChip";
import RequesterMessage from "../components/RequesterMessage";
import { clampVisibility, visibilityValuesFor } from "../utils/feedbackVisibility";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import { invalidateFeedback } from "../utils/feedbackQueries";
import { safeBackParam } from "../utils/url";

const PROVIDED = "/feedback?tab=provided";

export default function EditFeedback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  // An explicit `back` (e.g. the per-manager feedbacks screen) overrides the tab default;
  // otherwise return to whichever tab the editor was opened from (team tab for managers).
  const backTo =
    safeBackParam(searchParams) ??
    (searchParams.get("from") === "team" ? "/feedback?tab=team" : PROVIDED);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<FeedbackStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [rejectOpen, { open: openReject, close: closeReject }] = useDisclosure(false);
  const [deleteOpen, { open: openDelete, close: closeDelete }] = useDisclosure(false);

  const id = Number(params.id);
  const idIsValid = Number.isFinite(id) && id > 0;

  const {
    data,
    isLoading,
    isError,
    error: fetchError,
  } = useQuery({
    queryKey: ["feedback", id],
    queryFn: () => getFeedback(id),
    enabled: idIsValid,
    retry: false,
  });

  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("FEEDBACKS")) return <Navigate to="/" replace />;
  if (!idIsValid) return <Navigate to={backTo} replace />;

  async function handleSave(
    status: FeedbackStatus,
    values: { visibility: FeedbackVisibility; content: string },
  ) {
    if (!data) return;
    // Accepting a request (REQUESTED → DRAFT) keeps the provider on this screen and reloads it
    // as the editor; every other save returns to the originating tab.
    const accepted = data.status === "REQUESTED" && status === "DRAFT";
    setError(null);
    setSubmitting(status);
    try {
      // Map the editor's intent onto the new verb design: content edits go through PUT, lifecycle
      // moves go through the POST action endpoints.
      if (data.status === "REQUESTED" && status === "DRAFT") {
        await pickUpFeedback(id); // Accept
      } else if (data.status === "REQUESTED" && status === "REJECTED") {
        await rejectFeedback(id); // Reject
      } else if (status === "SENT") {
        // Save & send: persist the draft content, then transition.
        await updateFeedback(id, { content: values.content, visibility: values.visibility });
        await sendFeedback(id);
      } else {
        // Save draft: content/visibility edit only.
        await updateFeedback(id, { content: values.content, visibility: values.visibility });
      }
      await invalidateFeedback(queryClient, id);
      showSuccessToast(
        t(
          accepted
            ? "feedback.toast.accepted"
            : status === "REJECTED"
              ? "feedback.toast.rejected"
              : status === "SENT"
                ? "feedback.toast.sent"
                : "feedback.toast.draftSaved",
        ),
      );
      if (!accepted) navigate(backTo, { replace: true });
    } catch (err) {
      setError(
        saveErrorMessage(err, t, {
          forbidden: "feedback.error.editPermission",
          notFound: "feedback.error.gone",
          conflict: "feedback.error.invalidTransition",
          invalid: "feedback.error.validation",
          failedStatus: "feedback.error.saveFailedStatus",
          failed: "feedback.error.saveFailed",
        }),
      );
    } finally {
      setSubmitting(null);
    }
  }

  async function handleDelete() {
    if (!data) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteFeedback(id);
      await invalidateFeedback(queryClient, id);
      showSuccessToast(t("feedback.toast.deleted"));
      navigate(backTo, { replace: true });
    } catch (err) {
      closeDelete();
      // No failedStatus key: an unmatched status falls to the generic delete-failed message.
      setError(
        saveErrorMessage(err, t, {
          forbidden: "feedback.error.editPermission",
          notFound: "feedback.error.gone",
          invalid: "feedback.error.deleteNotDraft",
          failed: "feedback.error.deleteFailed",
        }),
      );
    } finally {
      setDeleting(false);
    }
  }

  const notFound = isError && fetchError instanceof ApiError && fetchError.status === 404;

  if (isLoading || isError) {
    return (
      <>
        <PageHeader title={t("feedback.editTitle")} mb="lg" />
        <Container size="md" px={0}>
          <Paper withBorder shadow="sm" p="xl" radius="md">
            {isLoading ? (
              <Center py="xl">
                <Loader />
              </Center>
            ) : (
              <Stack>
                <Alert color="red" variant="light">
                  {notFound
                    ? t("feedback.error.notFound")
                    : fetchError instanceof ApiError
                      ? t("feedback.error.loadFailedStatus", { status: fetchError.status })
                      : t("feedback.error.loadFailed")}
                </Alert>
                <FormFooter>
                  <Button component={RouterLink} to={backTo} variant="default">
                    {t("feedback.backToFeedback")}
                  </Button>
                </FormFooter>
              </Stack>
            )}
          </Paper>
        </Container>
      </>
    );
  }

  // A REQUESTED feedback is a request the provider hasn't picked up yet — a triage decision,
  // not an editing screen. Offer Close / Reject / Accept instead of the editor (Accept = pick up
  // the request → DRAFT, then reload as the editor). Only `REQUESTED → DRAFT` and
  // `REQUESTED → REJECTED` are valid transitions, so "Save & send" must not be offered here.
  if (data!.status === "REQUESTED" && getUserId() === data!.providerId) {
    // A REQUESTED feedback has exactly one recipient (the server rule) — read it through the
    // shared subjects reader. A requested self-reflection (legacy rows): the caller (provider)
    // is also the subject — the reader renders the app-wide plain "You" instead of their own
    // avatar chip, and the triage line is worded for it.
    const [{ display: subjectDisplay, isYou: selfSubject }] = subjectDisplays(data!, getUserId(), t);
    const requesterDisplay =
      data!.requesterName ??
      (data!.requesterId != null ? `#${data!.requesterId}` : t("feedback.unknown"));
    const decide = (status: FeedbackStatus) =>
      handleSave(status, { visibility: data!.visibility, content: data!.content ?? "" });
    return (
      <>
        <PageHeader
          title={t("feedback.requestTitle")}
          description={t("feedback.triageLine", {
            requester: requesterDisplay,
            subject: subjectDisplay,
            context: selfSubject ? "self" : undefined,
          })}
          mb="lg"
        />
        <Container size="md" px={0}>
          <Paper withBorder shadow="sm" p="xl" radius="md">
            <Stack>
              <MetaStrip
                items={[
                  {
                    key: "subject",
                    label: t("common.field.subject"),
                    value: selfSubject ? (
                      <Text size="sm">{t("common.state.you")}</Text>
                    ) : (
                      <PersonaChip name={subjectDisplay} />
                    ),
                  },
                  {
                    key: "requester",
                    label: t("common.field.requester"),
                    value: <PersonaChip name={requesterDisplay} />,
                  },
                  // The requester's optional deadline (v3.8.0): the provider sees it before
                  // deciding — same field/gate as ViewFeedback's MetaStrip row.
                  ...(data!.expiresOn
                    ? [
                        {
                          key: "expiresOn",
                          label: t("feedback.expiresOnLabel"),
                          value: <DateCell value={data!.expiresOn} mode="date" />,
                        },
                      ]
                    : []),
                ]}
              />
              <RequesterMessage value={data!.requesterMessage} />
              {error && (
                <Alert color="red" variant="light">
                  {error}
                </Alert>
              )}
              <FormFooter>
                <Button
                  variant="default"
                  onClick={() => navigate(backTo, { replace: true })}
                  disabled={submitting !== null}
                >
                  {t("common.action.close")}
                </Button>
                <Button
                  color="red"
                  variant="light"
                  onClick={openReject}
                  loading={submitting === "REJECTED"}
                  disabled={submitting !== null}
                >
                  {t("feedback.action.reject")}
                </Button>
                <Button
                  onClick={() => decide("DRAFT")}
                  loading={submitting === "DRAFT"}
                  disabled={submitting !== null}
                >
                  {t("feedback.action.accept")}
                </Button>
              </FormFooter>
            </Stack>
          </Paper>
        </Container>

        <ConfirmActionModal
          opened={rejectOpen}
          onClose={closeReject}
          title={t("feedback.rejectTitle")}
          message={t("feedback.rejectBody")}
          cancelLabel={t("common.action.keepEditing")}
          confirmLabel={t("feedback.action.reject")}
          onConfirm={() => {
            closeReject();
            decide("REJECTED");
          }}
        />
      </>
    );
  }

  const hasRequester = data!.requesterId != null;
  const visibilityOptions = visibilityValuesFor(hasRequester).map((value) => ({
    value,
    label: t(`common.visibility.${value}`),
  }));
  // Delete is a draft-only, provider-only action (mirrors the backend guard).
  const canDelete = data!.status === "DRAFT" && getUserId() === data!.providerId;
  return (
    <>
      <FeedbackForm
        title={t("feedback.editTitle")}
        feedbackId={data!.id}
        currentStatus={data!.status}
        // A legacy self-reflection (the caller among the recipients) renders as the same
        // plain "You" FeedbackForm uses for the provider side — subjectDisplays' isYou flag.
        subjects={subjectDisplays(data!, getUserId(), t)}
        initialVisibility={clampVisibility(data!.visibility, hasRequester)}
        visibilityOptions={visibilityOptions}
        requesterDisplay={hasRequester ? (data!.requesterName ?? `#${data!.requesterId}`) : undefined}
        requesterMessage={data!.requesterMessage}
        initialContent={data!.content ?? ""}
        lastModified={data!.lastModified}
        submitting={submitting}
        error={error}
        onSubmit={handleSave}
        cancelTo={backTo}
        showTemplateInsert
        discardTitle={t("feedback.discardChangesTitle")}
        discardMessage={t("feedback.discardChangesMessage")}
        onDelete={canDelete ? openDelete : undefined}
        deleting={deleting}
      />
      {canDelete && (
        <ConfirmActionModal
          opened={deleteOpen}
          onClose={closeDelete}
          title={t("feedback.deleteTitle")}
          message={t("feedback.deleteBody")}
          cancelLabel={t("common.action.keepEditing")}
          confirmLabel={t("common.action.delete")}
          onConfirm={handleDelete}
          loading={deleting}
        />
      )}
    </>
  );
}
