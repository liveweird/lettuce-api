import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Container, Paper, Select, Stack, Text } from "@mantine/core";
import EmojiTextarea from "../components/EmojiTextarea";
import { MAX_REQUESTER_MESSAGE_LENGTH } from "../utils/feedbackForm";
import { feedbackViewLink } from "../utils/feedbackLinks";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getUserId, hasFeature } from "../api/session";
import { createFeedback, type FeedbackVisibility } from "../api/feedbacks";
import DiscardGuard from "../components/DiscardGuard";
import DuplicateFeedbackAlert from "../components/DuplicateFeedbackAlert";
import FeedbackExpirationField from "../components/FeedbackExpirationField";
import FormFooter from "../components/FormFooter";
import MetaStrip from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import PersonaChip from "../components/PersonaChip";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import { useFeedbackDuplicate } from "../hooks/useFeedbackDuplicate";
import { REQUESTER_VISIBILITIES } from "../utils/feedbackVisibility";
import { saveErrorMessage } from "../utils/saveError";
import { REQUEST_ERROR_KEYS, resolveFeedbackExpiresOn, type ExpirationPreset } from "../utils/feedbackForm";
import { showSuccessToast } from "../utils/toast";
import { invalidateFeedback } from "../utils/feedbackQueries";
import { safeBackParam } from "../utils/url";
import { useAllUsers } from "../hooks/useAllUsers";

// The asker is the requester, so "Ask for feedback" offers the requester-inclusive
// visibilities — the ones under which the requester (themselves) can read the result.
const DEFAULT_VISIBILITY: FeedbackVisibility = "PROVIDER_REQUESTER_SUBJECT";

export default function AskFeedback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const visibilityOptions = REQUESTER_VISIBILITIES.map((value) => ({
    value,
    label: t(`common.visibility.${value}`),
  }));

  const providerId = Number(searchParams.get("providerId"));
  // Return to the Dashboard tab the user came from; default to managers.
  const backTo = safeBackParam(searchParams) ?? "/?tab=managers";
  const requesterId = getUserId();

  const [visibility, setVisibility] = useState<FeedbackVisibility>(DEFAULT_VISIBILITY);
  const [message, setMessage] = useState("");
  // The expiration control (v3.8.0), the RequestFeedback sibling.
  const [expirationPreset, setExpirationPreset] = useState<ExpirationPreset>("none");
  const [customExpiresOn, setCustomExpiresOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The one cancel guard (v3.5.0): a typed note, a changed visibility, or a chosen expiration is
  // work worth a confirm.
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: message !== "" || visibility !== DEFAULT_VISIBILITY || expirationPreset !== "none",
    to: backTo,
    title: t("feedback.discardRequestTitle"),
    message: t("feedback.discardAskMessage"),
  });

  const providerIdIsValid = Number.isFinite(providerId) && providerId > 0;
  // The provider's display name resolves from the org pool — never from a URL param
  // (v2.35.0: a crafted name param could label the ask as someone else while the id
  // addresses the real provider); an id matching no user bounces back once the pool settles.
  const { userPool, usersReady } = useAllUsers();
  const provider = providerIdIsValid ? (userPool ?? []).find((u) => u.id === providerId) : undefined;
  // Warn up-front when this exact ask already exists (subject == requester == me).
  const duplicate = useFeedbackDuplicate(
    providerIdIsValid && requesterId != null
      ? { subjectId: requesterId, providerId, requesterId }
      : null,
  );
  // Per-user feature flag (v1.53.0): the whole page area is hidden when disabled.
  if (!hasFeature("FEEDBACKS")) return <Navigate to="/" replace />;
  if (!providerIdIsValid || requesterId == null) return <Navigate to={backTo} replace />;
  if (usersReady && !provider) return <Navigate to={backTo} replace />;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      // I'm asking my manager (provider) to give feedback about me: subject == requester == me.
      await createFeedback({
        requesterId: requesterId!,
        subjectId: requesterId!,
        providerId,
        visibility,
        status: "REQUESTED",
        content: "",
        requesterMessage: message.trim() || undefined,
        expiresOn: resolveFeedbackExpiresOn(expirationPreset, customExpiresOn),
      });
      await invalidateFeedback(queryClient);
      showSuccessToast(t("feedback.toast.requested"));
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(
        saveErrorMessage(err, t, REQUEST_ERROR_KEYS),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title={t("feedback.askTitle")} mb="lg" />
      <Container size="md" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          <Stack>
            {/* The context line (v3.5.0): who is asked, about whom. */}
            <MetaStrip
              items={[
                {
                  key: "provider",
                  label: t("common.field.provider"),
                  value: <PersonaChip name={provider?.name ?? `#${providerId}`} />,
                },
                {
                  key: "subject",
                  label: t("common.field.subject"),
                  value: <Text size="sm">{t("common.state.you")}</Text>,
                },
              ]}
            />

            {duplicate.existingId != null && (
              // The caller is the requester of the existing row, so the view route is theirs.
              <DuplicateFeedbackAlert
                status={duplicate.existingStatus ?? "REQUESTED"}
                to={feedbackViewLink(duplicate.existingId)}
              />
            )}

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

            <FeedbackExpirationField
              preset={expirationPreset}
              onPresetChange={setExpirationPreset}
              customDate={customExpiresOn}
              onCustomDateChange={setCustomExpiresOn}
            />

            {error && (
              <Alert color="red" variant="light">
                {error}
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
                disabled={duplicate.existingId != null}
              >
                {t("feedback.action.sendRequest")}
              </Button>
            </FormFooter>
          </Stack>
        </Paper>
      </Container>

      <DiscardGuard {...guardProps} />
    </>
  );
}
