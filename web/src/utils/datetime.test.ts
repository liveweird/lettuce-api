import { afterEach, describe, expect, test, vi } from "vitest";
import {
  addIsoDays,
  currentIsoMonth,
  formatIsoMonth,
  formatIsoMonthShort,
  formatMonthRangeShort,
  formatIsoWeekday,
  formatMonthRange,
  formatRelativeTime,
  formatDateTime,
  formatIsoDateRange,
  isCurrentPeriod,
  isoDayDiff,
  lastModifiedCutoff,
  nextIsoMonth,
} from "./datetime";

describe("formatIsoWeekday", () => {
  test("renders the localized short weekday of an ISO date", () => {
    expect(formatIsoWeekday("2026-01-06", "en")).toBe("Tue");
    expect(formatIsoWeekday("2026-01-06", "pl")).toBe("wt.");
    expect(formatIsoWeekday("2099-03-02", "en")).toBe("Mon");
  });

  test("renders an empty string for malformed input", () => {
    expect(formatIsoWeekday("garbage", "en")).toBe("");
  });
});

describe("day arithmetic (the pyramid time slider)", () => {
  test("isoDayDiff and addIsoDays are inverse, across month and year bounds", () => {
    expect(isoDayDiff("2026-08-01", "2026-08-15")).toBe(14);
    expect(isoDayDiff("2026-08-15", "2026-08-15")).toBe(0);
    expect(isoDayDiff("2025-12-30", "2026-01-02")).toBe(3);
    expect(addIsoDays("2026-08-01", 14)).toBe("2026-08-15");
    expect(addIsoDays("2026-01-02", -3)).toBe("2025-12-30");
    expect(addIsoDays("2024-02-28", 1)).toBe("2024-02-29"); // leap day
    expect(addIsoDays("garbage", 7)).toBe("garbage"); // malformed passes through
    const from = "2015-01-01";
    const to = "2026-08-15";
    expect(addIsoDays(from, isoDayDiff(from, to))).toBe(to);
  });
});

describe("formatDateTime", () => {
  const expected = (ms: number, locale: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  test("renders the localized medium date + short time in local time", () => {
    const ms = new Date(2026, 0, 5, 9, 7).getTime();
    expect(formatDateTime(ms, "en")).toBe(expected(ms, "en"));
    expect(formatDateTime(ms, "en")).toContain("Jan 5, 2026");
    expect(formatDateTime(ms, "pl")).toBe(expected(ms, "pl"));
    expect(formatDateTime(ms, "pl")).toContain("2026");
  });
});

describe("formatIsoDateRange", () => {
  test("joins two localized days with an en dash and collapses a same-day range", () => {
    expect(formatIsoDateRange("2026-07-01", "2026-07-31", "en")).toBe("Jul 1, 2026 – Jul 31, 2026");
    expect(formatIsoDateRange("2026-07-01", "2026-07-01", "en")).toBe("Jul 1, 2026");
  });
});

describe("formatRelativeTime", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  afterEach(() => vi.restoreAllMocks());

  test("picks the largest unit with a non-zero value", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatRelativeTime(NOW - 2 * DAY, "en")).toBe("2 days ago");
    expect(formatRelativeTime(NOW - 3 * HOUR, "en")).toBe("3 hours ago");
    expect(formatRelativeTime(NOW - 9 * DAY, "en")).toBe("last week");
    expect(formatRelativeTime(NOW - 70 * DAY, "en")).toBe("2 months ago");
  });

  test("sub-minute deltas render as the current minute", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatRelativeTime(NOW - 20 * 1000, "en")).toBe("this minute");
  });

  test("localizes via the passed locale", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(formatRelativeTime(NOW - 2 * DAY, "pl")).toBe("przedwczoraj");
  });
});

describe("lastModifiedCutoff", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  afterEach(() => vi.restoreAllMocks());

  test("'all' applies no bound", () => {
    expect(lastModifiedCutoff("all")).toBeUndefined();
  });

  test("'week' is now minus 7 days", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(lastModifiedCutoff("week")).toBe(NOW - 7 * DAY);
  });

  test("'month' is now minus 30 days", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(lastModifiedCutoff("month")).toBe(NOW - 30 * DAY);
  });

  test("recomputes against the current clock on each call", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(lastModifiedCutoff("week")).toBe(NOW - 7 * DAY);
    spy.mockReturnValue(NOW + DAY);
    expect(lastModifiedCutoff("week")).toBe(NOW + DAY - 7 * DAY);
  });
});

describe("month formatting (review periods)", () => {
  test("formatIsoMonth localizes a YYYY-MM month and passes malformed input through", () => {
    expect(formatIsoMonth("2026-01", "en")).toBe("January 2026");
    expect(formatIsoMonth("2026-12", "pl")).toBe("grudzień 2026");
    expect(formatIsoMonth("garbage", "en")).toBe("garbage");
  });

  test("formatMonthRange renders the inclusive range and collapses a single-month period", () => {
    expect(formatMonthRange("2026-01", "2026-06", "en")).toBe("January 2026 – June 2026");
    expect(formatMonthRange("2026-03", "2026-03", "en")).toBe("March 2026");
  });

  test("formatMonthRangeShort abbreviates the months (the compact person-card form)", () => {
    expect(formatMonthRangeShort("2026-08", "2027-01", "en")).toBe("Aug 2026 – Jan 2027");
    expect(formatMonthRangeShort("2026-03", "2026-03", "en")).toBe("Mar 2026");
    expect(formatIsoMonthShort("garbage", "en")).toBe("garbage");
  });

  test("nextIsoMonth steps one month and rolls over a year boundary", () => {
    expect(nextIsoMonth("2026-06")).toBe("2026-07");
    expect(nextIsoMonth("2026-12")).toBe("2027-01");
    expect(nextIsoMonth("bogus")).toBe("bogus");
  });

  test("currentIsoMonth is today's YYYY-MM in local time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-03T12:00:00"));
    try {
      expect(currentIsoMonth()).toBe("2026-08");
    } finally {
      vi.useRealTimers();
    }
  });

  test("isCurrentPeriod is inclusive on both month bounds", () => {
    expect(isCurrentPeriod("2026-01", "2026-06", "2026-01")).toBe(true);
    expect(isCurrentPeriod("2026-01", "2026-06", "2026-03")).toBe(true);
    expect(isCurrentPeriod("2026-01", "2026-06", "2026-06")).toBe(true);
    expect(isCurrentPeriod("2026-01", "2026-06", "2025-12")).toBe(false);
    expect(isCurrentPeriod("2026-01", "2026-06", "2026-07")).toBe(false);
    // Single-month period.
    expect(isCurrentPeriod("2026-03", "2026-03", "2026-03")).toBe(true);
  });
});
