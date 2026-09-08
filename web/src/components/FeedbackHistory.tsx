import { dynamicKey } from "../utils/i18nKey";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { listFeedbackEvents, type FeedbackEvent } from "../api/feedbacks";
import EventTimeline from "./EventTimeline";

// Render a structured audit event in the current language.
function describeEvent(e: FeedbackEvent, t: TFunction): string {
  const p = e.params ?? {};
  switch (e.type) {
    case "CREATED":
      return t("feedback.event.created", { context: p.status });
    case "DELETED":
      return t("feedback.event.deleted");
    case "STATUS_CHANGED":
      return t("feedback.event.statusChanged", {
        from: t(dynamicKey(`common.status.${p.from}`)),
        to: t(dynamicKey(`common.status.${p.to}`)),
      });
    case "CONTENT_UPDATED":
      return t("feedback.event.contentUpdated");
    case "CONTENT_AND_VISIBILITY_UPDATED":
      return t("feedback.event.contentAndVisibilityUpdated");
    case "VISIBILITY_CHANGED":
      return t("feedback.event.visibilityChanged", { to: t(dynamicKey(`common.visibility.${p.to}`)) });
    case "REQUEST_EXPIRED":
      return t("feedback.event.requestExpired");
    default:
      // Forward-compat: an event kind this client build doesn't know yet — show the raw type.
      return e.type;
  }
}

/** The feedback's audit history as a timeline (newest first, server-ordered), or an empty-state note. */
export default function FeedbackHistory({ feedbackId }: { feedbackId: number }) {
  const { t } = useTranslation();
  const { data: events, isLoading, isError, error } = useQuery({
    queryKey: ["feedbackEvents", feedbackId],
    queryFn: () => listFeedbackEvents(feedbackId),
  });

  return (
    <EventTimeline
      events={events}
      isLoading={isLoading}
      isError={isError}
      error={error}
      emptyMessage={t("feedback.noHistory")}
      renderTitle={(e) => describeEvent(e, t)}
    />
  );
}
