import type { TFunction } from "i18next";
// Epoch millis -> a localized absolute timestamp ("Jul 1, 2026, 9:07 AM" / "1 lip 2026, 09:07")
// in local time — the app's ONE timestamp format (v3.5.0; replaced the en-only "YYYY-MM-DD
// HH:mm" formatTimestamp): history rows, alert bounds, and the exact `title` behind every
// relative phrase.
export function formatDateTime(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

// Epoch millis -> a localized relative phrase ("2 days ago"), picking the largest unit that
// has a non-zero value. Intl handles the per-language plural rules, so no i18n keys needed.
export function formatRelativeTime(ms: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const deltaSec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 60) return rtf.format(0, "minute"); // "this minute" / "w tej minucie"
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 24 * 3600],
    ["month", 30 * 24 * 3600],
    ["week", 7 * 24 * 3600],
    ["day", 24 * 3600],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, sec] of units) {
    if (abs >= sec) return rtf.format(Math.trunc(deltaSec / sec), unit);
  }
  return rtf.format(0, "minute");
}

// ISO "YYYY-MM-DD" -> a localized date ("Jul 1, 2026" / "1 lip 2026"). The T00:00:00 suffix
// pins parsing to local time (a bare ISO date would parse as UTC and shift across midnight).
// Malformed input renders as-is rather than "Invalid Date".
export function formatIsoDate(iso: string, locale: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
}

// An inclusive ISO day range ("Jul 1, 2026 – Jul 31, 2026"); a single day renders once. The
// periods' one formatter (v3.5.0) — impact-log entries, and any future from/to column.
export function formatIsoDateRange(start: string, end: string, locale: string): string {
  if (start === end) return formatIsoDate(start, locale);
  return `${formatIsoDate(start, locale)} – ${formatIsoDate(end, locale)}`;
}

// ISO "YYYY-MM-DD" -> the localized short weekday ("Tue" / "wt."), rendered dimmed next to
// formatIsoDate on the days-off and public-holiday lists (v3.1.0). Same local-time pinning;
// malformed input renders as "" so the caller's slot stays empty rather than "Invalid Date".
export function formatIsoWeekday(iso: string, locale: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
}

// ISO "YYYY-MM" -> a localized month ("January 2026" / "styczeń 2026"). The -01T00:00:00
// suffix pins parsing to local time (the formatIsoDate rationale). Malformed input renders
// as-is rather than "Invalid Date".
export function formatIsoMonth(month: string, locale: string): string {
  const d = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return month;
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(d);
}

// A review period's inclusive month range ("January 2026 – June 2026"); a single-month period
// renders as just that month.
export function formatMonthRange(start: string, end: string, locale: string): string {
  if (start === end) return formatIsoMonth(start, locale);
  return `${formatIsoMonth(start, locale)} – ${formatIsoMonth(end, locale)}`;
}

// ISO "YYYY-MM" -> a localized SHORT month ("Aug 2026" / "sie 2026"). The compact form for
// space-tight contexts (the person cards' last-review row, where the full month name + a status
// badge overflow the narrow two-column body). Same local-time pin / passthrough as formatIsoMonth.
export function formatIsoMonthShort(month: string, locale: string): string {
  const d = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return month;
  return new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(d);
}

// formatMonthRange with abbreviated months ("Aug 2026 – Jan 2027"); the compact sibling for the
// person cards. A single-month period renders as just that short month.
export function formatMonthRangeShort(start: string, end: string, locale: string): string {
  if (start === end) return formatIsoMonthShort(start, locale);
  return `${formatIsoMonthShort(start, locale)} – ${formatIsoMonthShort(end, locale)}`;
}

// ISO "YYYY-MM" plus [months] — period-end defaults and the adjacency rule both step months.
// Malformed input passes through.
export function addIsoMonths(month: string, months: number): string {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return month;
  const total = Number(match[1]) * 12 + (Number(match[2]) - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

// The ISO "YYYY-MM" month right after the given one — the required start of the next review
// period (the timeline is append-only and gapless).
export function nextIsoMonth(month: string): string {
  return addIsoMonths(month, 1);
}

// The 12 months as Select options: values "01".."12", labels localized full month names.
export function monthOptions(locale: string): { value: string; label: string }[] {
  const format = new Intl.DateTimeFormat(locale, { month: "long" });
  return Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1).padStart(2, "0"),
    label: format.format(new Date(2000, i, 1)),
  }));
}

// Consecutive years as Select options (inclusive bounds).
export function yearOptions(from: number, to: number): { value: string; label: string }[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    value: String(from + i),
    label: String(from + i),
  }));
}

// Today's date as the ISO "YYYY-MM-DD" an <input type="date"> uses (local time).
export function todayIsoDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Whole days from one ISO "YYYY-MM-DD" to another (negative when to < from) — UTC-anchored
// parsing so DST transitions can't skew the count. Backs the pyramid time slider's mapping.
export function isoDayDiff(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

// The ISO date [days] whole days after [iso] (negative = before) — the isoDayDiff inverse.
// Malformed input passes through (the formatIsoDate convention).
export function addIsoDays(iso: string, days: number): string {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed)) return iso;
  const d = new Date(parsed + days * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// True for a well-formed, actually-parseable ISO "YYYY-MM-DD" — the <input type="date">
// validation the pulse admin forms run before date arithmetic or a submit.
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Round-trip: Date rolls an overflow day over ("2026-02-30" parses as March 2nd), so a
  // parse that survives must also print back as the same calendar date (v3.5.2).
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// The current month as ISO "YYYY-MM" (local time) — the review-period granularity.
export function currentIsoMonth(): string {
  return todayIsoDate().slice(0, 7);
}

// True when the inclusive [startMonth, endMonth] period contains [now] — zero-padded ISO
// YYYY-MM strings compare lexicographically == chronologically, so plain <= works. Drives the
// "current period" highlight on every period picker/list.
export function isCurrentPeriod(
  startMonth: string,
  endMonth: string,
  now: string = currentIsoMonth(),
): boolean {
  return startMonth <= now && now <= endMonth;
}

// Epoch millis -> value for an <input type="datetime-local"> ("YYYY-MM-DDTHH:mm", local time).
// Null/undefined -> "" (the input's "unset" value).
export function epochToDatetimeLocal(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

// <input type="datetime-local"> value -> epoch millis; "" (unset) -> null.
export function datetimeLocalToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Epoch millis -> a localized absolute date ("Jul 1, 2026" / "1 lip 2026"), no time part.
// Used where the moment matters at day granularity over long spans (a goal's creation date) —
// relative phrasing degrades into "3 months ago" there.
export function formatDate(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(ms));
}

// Recency windows for the "Last modified" list filter.
export type LastModifiedWindow = "all" | "week" | "month";

// Built from a translator so the labels stay localized; callers pass their `t` from useTranslation.
export function lastModifiedOptions(t: TFunction) {
  return [
    { value: "all", label: t("common.state.all") },
    { value: "week", label: t("feedback.lastWeek") },
    { value: "month", label: t("feedback.lastMonth") },
  ];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling lower bound, recomputed per call so windows always track "now".
const daysAgo = (days: number) => Date.now() - days * DAY_MS;

// Epoch-millis lower bound for the window, or undefined for "all".
export function lastModifiedCutoff(w: LastModifiedWindow): number | undefined {
  if (w === "week") return daysAgo(7);
  if (w === "month") return daysAgo(30);
  return undefined;
}

// Creation-date windows for the goals list filter (goals live for months, so the windows are
// wider than the lastModified ones).
export type CreatedWindow = "all" | "month" | "sixMonths";

export function createdWindowOptions(t: TFunction) {
  return [
    { value: "all", label: t("common.state.all") },
    { value: "month", label: t("goal.createdWindow.month") },
    { value: "sixMonths", label: t("goal.createdWindow.sixMonths") },
  ];
}

export function createdWindowCutoff(w: CreatedWindow): number | undefined {
  if (w === "month") return daysAgo(30);
  if (w === "sixMonths") return daysAgo(182);
  return undefined;
}
