import type { ParseKeys } from "i18next";
import { useState } from "react";
import {
  Link as RouterLink,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Alert, Button, Container, Group, Paper, Stack, Tabs, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { ApiError } from "../api/http";
import { getUserId, hasFeature } from "../api/session";
import { getFeedback, pickUpFeedback, sendFeedback, withdrawFeedback, type FeedbackStatus } from "../api/feedbacks";
import CenteredLoader from "../components/CenteredLoader";
import DateCell from "../components/DateCell";
import { StatusBadge, VisibilityBadge } from "../components/FeedbackBadges";
import FeedbackHistory from "../components/FeedbackHistory";
import FeedbackLifecycle from "../components/FeedbackLifecycle";
import MarkdownView from "../components/MarkdownView";
import MetaStrip, { type MetaStripItem } from "../components/MetaStrip";
import PageHeader from "../components/PageHeader";
import PersonCell from "../components/PersonCell";
import ProseBox from "../components/ProseBox";
import RequesterMessage from "../components/RequesterMessage";
import ConfirmActionModal from "../components/ConfirmActionModal";
import { feedbackSubjects } from "../utils/feedbackSubjects";
import { showSuccessToast } from "../utils/toast";
import { saveErrorMessage } from "../utils/saveError";
import { invalidateFeedback } from "../utils/feedbackQueries";
import { safeBackParam } from "../utils/url";

const RECEIVED = "/feedback?tab=received";

// The single status transition a provider can perform from each status (matches the
// backend state machine in FeedbackService.isAllowedTransition). WITHDRAWN is terminal
// and intentionally absent → the provider sees only Close. `labelKey` resolves via i18n.
const NEXT_ACTION: Partial<
  Record<FeedbackStatus, { labelKey: ParseKeys; successKey: ParseKeys; run: (id: number) => Promise<void>; confirm?: boolean }>
> = {
  REQUESTED: { labelKey: "feedback.action.draft", successKey: "feedback.toast.accepted", run: pickUpFeedback },
  DRAFT: { labelKey: "feedback.action.send", successKey: "feedback.toast.sent", run: sendFeedback },
  SENT: { labelKey: "feedback.action.withdraw", successKey: "feedback.toast.withdrawn", run: withdrawFeedback, confirm: true },
};

/**
 * The feedback document (the v3.5.0 detail layout): the page header carries the status and
 * visibility pills plus Close and the provider's single lifecycle action; the identity strip
 * names the parties — provider, every recipient in position order, the requester when there
 * is one (the app-wide PersonCell rule: a chip for others, plain "You" for the caller) — and
 * the Content / History / Lifecycle tabs follow, the content in a border-first prose box
 * sized to the text.
 */
export default function ViewFeedback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const as = searchParams.get("as");
  const asProvider = as === "provider";
  const asTeam = as === "team";
  // An explicit `back` (e.g. the per-manager feedbacks screen) overrides the tab default.
  const backOverride = safeBackParam(searchParams);
  const backTo =
    backOverride ??
    (asTeam ? "/feedback?tab=team" : asProvider ? "/feedback?tab=provided" : RECEIVED);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);

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

  const currentUserId = getUserId();
  // The provider (not the as=provider display hint) is the only one who can change status.
  const isProvider = data != null && currentUserId === data.providerId;
  const action = isProvider ? NEXT_ACTION[data!.status] : undefined;
  // A requester watching a feedback they requested may see that it exists, but not its content
  // while it is unfinished: never drafted (REQUESTED), still a private draft (DRAFT), or declined
  // (REJECTED). The server also redacts the content field for these cases; hiding the section here
  // avoids rendering an empty Content box.
  const isRequester = data != null && data.requesterId != null && currentUserId === data.requesterId;
  const hideContent =
    isRequester &&
    (data!.status === "REQUESTED" || data!.status === "REJECTED" || data!.status === "DRAFT");

  async function handleAction(run: (id: number) => Promise<void>, successKey: ParseKeys) {
    if (!data) return;
    setActionError(null);
    setSubmitting(true);
    try {
      await run(id);
      await invalidateFeedback(queryClient, id);
      showSuccessToast(t(successKey));
      navigate(backTo, { replace: true });
    } catch (err) {
      setActionError(
        saveErrorMessage(err, t, {
          forbidden: "feedback.error.changePermission",
          notFound: "feedback.error.gone",
          conflict: "feedback.error.invalidTransition",
          invalid: "feedback.error.invalidTransition",
          failedStatus: "feedback.error.updateFailedStatus",
          failed: "feedback.error.updateFailed",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const errorStatus = fetchError instanceof ApiError ? fetchError.status : null;
  const errorMessage =
    errorStatus === 404
      ? t("feedback.error.notFound")
      : errorStatus === 403
        ? t("feedback.error.viewPermission")
        : errorStatus != null
          ? t("feedback.error.loadFailedStatus", { status: errorStatus })
          : t("feedback.error.loadFailed");

  // The parties, in the people-line order: provider → recipients · requester. The single
  // response carries no *Deleted flags (unlike the list rows), so deleted parties still chip.
  const metaItems: MetaStripItem[] = data
    ? [
        {
          key: "provider",
          label: t("common.field.provider"),
          value: <PersonCell userId={data.providerId} name={data.providerName} currentUserId={currentUserId} />,
        },
        {
          key: "recipients",
          label: t("feedback.recipientsLabel"),
          value: (
            <Group gap="sm" wrap="wrap">
              {feedbackSubjects(data).map((subject) => (
                <PersonCell
                  key={subject.id}
                  userId={subject.id}
                  name={subject.name}
                  deleted={subject.deleted}
                  currentUserId={currentUserId}
                />
              ))}
            </Group>
          ),
        },
        ...(data.requesterId != null
          ? [
              {
                key: "requester",
                label: t("common.field.requester"),
                value: (
                  <PersonCell userId={data.requesterId} name={data.requesterName} currentUserId={currentUserId} />
                ),
              },
            ]
          : []),
        // The requester's optional deadline (v3.8.0) — meaningful only while REQUESTED; once the
        // provider picks up/declines the row it's inert (the requesterMessage precedent).
        ...(data.status === "REQUESTED" && data.expiresOn
          ? [
              {
                key: "expiresOn",
                label: t("feedback.expiresOnLabel"),
                value: <DateCell value={data.expiresOn} mode="date" />,
              },
            ]
          : []),
        {
          key: "lastModified",
          label: t("common.field.lastModified"),
          value: <DateCell value={data.lastModified} mode="relative" />,
        },
      ]
    : [];

  return (
    <>
      <Stack gap="md">
        <PageHeader
          title={t("feedback.viewTitle")}
          badge={
            data && (
              <Group gap="xs" wrap="nowrap">
                <StatusBadge status={data.status} />
                <VisibilityBadge visibility={data.visibility} />
              </Group>
            )
          }
          actions={
            <>
              <Button component={RouterLink} to={backTo} variant="default">
                {t("common.action.close")}
              </Button>
              {action && (
                <Button
                  onClick={() =>
                    action.confirm ? openConfirm() : handleAction(action.run, action.successKey)
                  }
                  loading={submitting}
                >
                  {t(action.labelKey)}
                </Button>
              )}
            </>
          }
        />

        {actionError && (
          <Alert color="red" variant="light">
            {actionError}
          </Alert>
        )}

        <Container size="md" px={0} w="100%">
          <Paper withBorder radius="md" p="md">
            {isLoading ? (
              <CenteredLoader />
            ) : isError ? (
              <Alert color="red" variant="light">
                {errorMessage}
              </Alert>
            ) : data ? (
              <Stack gap="md">
                <MetaStrip items={metaItems} />
                <RequesterMessage value={data.requesterMessage} collapsible />
                <Tabs defaultValue="content" keepMounted={false}>
                  <Tabs.List>
                    <Tabs.Tab value="content">{t("common.field.content")}</Tabs.Tab>
                    <Tabs.Tab value="history">{t("feedback.history")}</Tabs.Tab>
                    <Tabs.Tab value="lifecycle">{t("feedback.lifecycle")}</Tabs.Tab>
                  </Tabs.List>

                  <Tabs.Panel value="content" pt="md">
                    {hideContent ? (
                      <Text c="dimmed" size="sm">
                        {t("feedback.contentUnavailable")}
                      </Text>
                    ) : (
                      <ProseBox>
                        <MarkdownView>{data.content}</MarkdownView>
                      </ProseBox>
                    )}
                  </Tabs.Panel>

                  <Tabs.Panel value="history" pt="md">
                    <FeedbackHistory feedbackId={id} />
                  </Tabs.Panel>

                  <Tabs.Panel value="lifecycle" pt="md">
                    <FeedbackLifecycle currentStatus={data.status} />
                  </Tabs.Panel>
                </Tabs>
              </Stack>
            ) : null}
          </Paper>
        </Container>
      </Stack>

      <ConfirmActionModal
        opened={confirmOpen}
        onClose={closeConfirm}
        title={t("feedback.withdrawTitle")}
        message={
          <Trans i18nKey="feedback.withdrawBody">
            Withdrawing this feedback is permanent — its status becomes <strong>Withdrawn</strong>{" "}
            and cannot be changed back. Continue?
          </Trans>
        }
        cancelLabel={t("common.action.cancel")}
        confirmLabel={t("feedback.action.withdraw")}
        loading={submitting}
        onConfirm={async () => {
          await handleAction(withdrawFeedback, "feedback.toast.withdrawn");
          closeConfirm();
        }}
      />
    </>
  );
}
