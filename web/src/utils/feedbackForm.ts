// Server-side free-text limits (server feedbacks/Feedback.kt) mirrored client-side (v2.18.0)
// so overlength is caught in the form, not as an API 400.
export const MAX_FEEDBACK_CONTENT_LENGTH = 5000;
export const MAX_REQUESTER_MESSAGE_LENGTH = 1000;

import { addIsoDays, todayIsoDate } from "./datetime";

// The requester's optional expiration presets on a request (v3.8.0, RequestFeedback +
// AskFeedback — see components/FeedbackExpirationField.tsx): "No expiration" (the default,
// today's indefinite behaviour) plus three fixed durations and a free date pick.
export type ExpirationPreset = "none" | "1w" | "2w" | "30d" | "custom";
export const EXPIRATION_PRESETS: ExpirationPreset[] = ["none", "1w", "2w", "30d", "custom"];

const PRESET_DAYS: Partial<Record<ExpirationPreset, number>> = { "1w": 7, "2w": 14, "30d": 30 };

/** Resolve the chosen preset (+ the picked date, for "custom") to the ISO `expiresOn` the create
 *  payload sends — `undefined` for "none" (indefinite) or an unset custom date, so it drops out
 *  of the JSON body entirely (the `requesterMessage` `|| undefined` idiom). */
export function resolveFeedbackExpiresOn(preset: ExpirationPreset, customDate: string): string | undefined {
  if (preset === "custom") return customDate || undefined;
  const days = PRESET_DAYS[preset];
  return days != null ? addIsoDays(todayIsoDate(), days) : undefined;
}

// The shared create-flow error-key maps (2026-08 audit round — previously copied
// byte-for-byte across CreateFeedback (kudo mode included) and AskFeedback/RequestFeedback; the
// PulseSettingsCard module-const idiom). Edit/delete keep their own page-local maps —
// their key sets genuinely differ.
import type { SaveErrorKeys } from "./saveError";

/** Providing feedback (CreateFeedback, its kudo mode included). */
export const PROVIDE_ERROR_KEYS: SaveErrorKeys = {
  forbidden: "feedback.error.providePermission",
  conflict: "feedback.error.duplicate",
  invalid: "feedback.error.validation",
  failedStatus: "feedback.error.createFailedStatus",
  failed: "feedback.error.createFailed",
};

/** Requesting feedback from providers (AskFeedback, RequestFeedback). */
export const REQUEST_ERROR_KEYS: SaveErrorKeys = {
  forbidden: "feedback.error.requestPermission",
  conflict: "feedback.error.duplicate",
  invalid: "feedback.error.validationSimple",
  failedStatus: "feedback.error.requestFailedStatus",
  failed: "feedback.error.requestFailed",
};
