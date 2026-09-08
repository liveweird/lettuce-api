import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReviewsDashboard from "./ReviewsDashboard";
import { jsonResponse } from "../test/http";

// happy-dom can't measure the recharts canvas — stub the chart primitives and assert the
// props our component passes (the ViewTeamKpi mock precedent). BarChart exposes the buckets
// and per-bar colors via data-* attrs and renders the custom tooltip once for inspection.
vi.mock("@mantine/charts", () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any -- typing the mocked BarChart/ChartTooltip props against @mantine/charts' real generics isn't worth it in a test-only stub */
  BarChart: ({ data, tooltipProps }: any) => (
    <div
      data-testid="bar-chart"
      data-buckets={data.map((d: any) => `${d.rating}:${d.count}`).join(",")}
      data-colors={data.map((d: any) => d.color).join(",")}
    >
      {tooltipProps?.content?.({ label: "4", payload: [] })}
    </div>
  ),
  ChartTooltip: ({ label }: any) => <div data-testid="chart-tooltip">{String(label)}</div>,
  /* eslint-enable @typescript-eslint/no-explicit-any */
}));

const TOKEN_KEY = "lettuce.auth.token";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

const PERIODS = [
  { id: 4, startMonth: "2025-07", endMonth: "2025-12" },
  { id: 5, startMonth: "2026-01", endMonth: "2026-06" },
];

const MEMBERS = [
  {
    userId: 8, name: "Ann Alpha", email: "a@x", teamId: 1, teamName: "AAA",
    careerPath: { id: 11, values: { en: "Software Engineer" } },
    careerSpecialization: null,
    seniorityLevel: { id: 31, values: { en: "Senior" } },
  },
  { userId: 9, name: "Zoe Zeta", email: "z@x", teamId: 2, teamName: "BBB" },
];

const REVIEW = {
  id: 21,
  managerId: 7, managerName: "Mona", managerDeleted: false,
  subordinateId: 8, subordinateName: "Ann Alpha", subordinateDeleted: false,
  periodId: 5, periodStartMonth: "2026-01", periodEndMonth: "2026-06",
  status: "CALIBRATION",
  attitudeRating: 4, deliveryRating: 3, skillsRating: 5, overallRating: 4,
  createdAt: 1, lastModified: 1,
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ReviewsDashboard />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("ReviewsDashboard tab", () => {
  let mockFetch: FetchMock;

  function setupMocks({ periods = PERIODS, reviews = [REVIEW] }: { periods?: unknown[]; reviews?: unknown[] } = {}) {
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/api/v1/review-periods")) {
        return Promise.resolve(jsonResponse(200, { items: periods }));
      }
      if (u.includes("/api/v1/teams/members")) {
        return Promise.resolve(
          jsonResponse(200, { items: MEMBERS, page: 1, pageSize: 100, total: MEMBERS.length }),
        );
      }
      if (u.includes("/api/v1/performance-reviews")) {
        return Promise.resolve(
          jsonResponse(200, { items: reviews, page: 1, pageSize: 100, total: (reviews as unknown[]).length }),
        );
      }
      if (u.includes("/api/v1/dictionaries/")) {
        return Promise.resolve(jsonResponse(200, { items: [{ id: 11, values: { en: "Software Engineer" } }] }));
      }
      return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 20, total: 0 }));
    });
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(USER_ID_KEY, "7"); // the manager viewing their org
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("every subordinate gets a row: review status + ratings, or the no-review state with New review", async () => {
    setupMocks();
    renderTab();

    // The period picker defaults to the latest period and scopes the reviews query.
    await waitFor(() =>
      expect(screen.getByLabelText("Period", { selector: "input" })).toHaveValue(
        "January 2026 – June 2026",
      ),
    );
    expect(await screen.findByText("Ann Alpha")).toBeInTheDocument();
    // Scope to the table — the closed filter Selects keep their option lists in the DOM.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Calibration")).toBeInTheDocument();
    expect(within(table).getByText("Software Engineer")).toBeInTheDocument();
    expect(within(table).getByText("Senior")).toBeInTheDocument();
    // Ann's ratings render as numbers; her CALIBRATION row opens the view screen (the
    // lifecycle actions live there — Edit is the DRAFT rows' action).
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View the performance review of Ann Alpha" }),
    ).toBeInTheDocument();
    // Zoe has no review yet — badge + the New-review action (direct scope).
    expect(screen.getByText("Zoe Zeta")).toBeInTheDocument();
    expect(screen.getByText("No review yet")).toBeInTheDocument();
    const newReview = screen.getByRole("link", { name: "New performance review for Zoe Zeta" });
    expect(newReview.getAttribute("href")).toContain("/performance-reviews/new?subordinateId=9");
    const reviewsCall = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/api/v1/performance-reviews?"));
    expect(reviewsCall).toContain("periodId=5");
    expect(reviewsCall).toContain("includeIndirect=true");
  });

  test("a stored period choice is restored over the latest-period default", async () => {
    // The Select persists like the filters (v1.33.4); pin the restore path so it never
    // regresses to always-latest. useStoredState stores JSON under the viewSettings prefix.
    localStorage.setItem("lettuce.viewSettings.dashboardReviews.period", JSON.stringify("4"));
    setupMocks();
    renderTab();

    await waitFor(() =>
      expect(screen.getByLabelText("Period", { selector: "input" })).toHaveValue(
        "July 2025 – December 2025",
      ),
    );
    const reviewsCall = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/api/v1/performance-reviews?"));
    expect(reviewsCall).toContain("periodId=4");
  });

  test("without a stored choice the default is the CURRENT period, not a pre-appended future one", async () => {
    // An admin may append next periods ahead of time (the registry is append-only); the
    // dashboard must still open on the period containing today (2026-08 audit round).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T12:00:00"));
    try {
      setupMocks({ periods: [...PERIODS, { id: 6, startMonth: "2026-07", endMonth: "2026-12" }] });
      renderTab();

      await waitFor(() =>
        expect(screen.getByLabelText("Period", { selector: "input" })).toHaveValue(
          "January 2026 – June 2026",
        ),
      );
      const reviewsCall = mockFetch.mock.calls
        .map((c) => String(c[0]))
        .find((u) => u.includes("/api/v1/performance-reviews?"));
      expect(reviewsCall).toContain("periodId=5");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the period containing today carries the Current marker in the picker", async () => {
    // Fake only Date (the TeamMembersTable idiom) so waitFor keeps real timers; today falls
    // inside period 5 and outside period 4.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T12:00:00"));
    try {
      setupMocks();
      renderTab();

      const picker = await screen.findByLabelText("Period", { selector: "input" });
      fireEvent.click(picker);
      const current = await screen.findByRole("option", { name: /January 2026 – June 2026/ });
      expect(within(current).getByText("Current")).toBeInTheDocument();
      const other = screen.getByRole("option", { name: /July 2025 – December 2025/ });
      expect(within(other).queryByText("Current")).toBeNull();
      // The marker never leaks into the closed input's value (it mirrors the label only).
      expect(picker).toHaveValue("January 2026 – June 2026");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the indirect scope widens the member fetch and hides the New-review action", async () => {
    setupMocks();
    renderTab();

    await screen.findByText("Zoe Zeta");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByLabelText("Reports", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "All reports (including indirect)" }));

    await screen.findByText("Zoe Zeta");
    expect(screen.queryByRole("link", { name: /New performance review/ })).toBeNull();
    const memberCalls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(memberCalls.some((u) => u.includes("/api/v1/teams/members") && u.includes("includeIndirect=true"))).toBe(
      true,
    );
  });

  test("the team and career filters narrow the rows client-side", async () => {
    setupMocks();
    renderTab();

    await screen.findByText("Zoe Zeta");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByLabelText("Team", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "AAA" }));
    expect(await screen.findByText("Ann Alpha")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Zoe Zeta")).toBeNull();

    // Back to all teams, then filter by career path — only Ann carries entry 11.
    fireEvent.click(screen.getByLabelText("Team", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "All" }));
    await screen.findByText("Zoe Zeta");
    fireEvent.click(screen.getByLabelText("Career path", { selector: "input" }));
    const options = await screen.findAllByRole("option", { name: "Software Engineer" });
    fireEvent.click(options[0]);
    expect(await screen.findByText("Ann Alpha")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByText("Zoe Zeta")).toBeNull();
  });

  test("sortable headers: Overall orders numerically with no-review rows last both ways", async () => {
    setupMocks();
    renderTab();

    await screen.findByText("Zoe Zeta");
    // Default sort is name asc: Ann, Zoe.
    const names = () =>
      within(screen.getByRole("table"))
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.textContent ?? "");
    expect(names()[0]).toContain("Ann Alpha");

    // Overall asc: Ann (4) before Zoe (no review, sinks last)…
    fireEvent.click(screen.getByRole("button", { name: "Overall" }));
    expect(names()[0]).toContain("Ann Alpha");
    expect(names()[1]).toContain("Zoe Zeta");
    // …and desc keeps the no-review row last.
    fireEvent.click(screen.getByRole("button", { name: "Overall" }));
    expect(names()[0]).toContain("Ann Alpha");
    expect(names()[1]).toContain("Zoe Zeta");
  });

  test("pages the joined rows client-side", async () => {
    const crowd = Array.from({ length: 25 }, (_, i) => ({
      userId: 100 + i,
      name: `Crowd ${String(i).padStart(2, "0")}`,
      email: `c${i}@x`,
      teamId: 1,
      teamName: "AAA",
    }));
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/api/v1/review-periods")) {
        return Promise.resolve(jsonResponse(200, { items: PERIODS }));
      }
      if (u.includes("/api/v1/teams/members")) {
        return Promise.resolve(
          jsonResponse(200, { items: crowd, page: 1, pageSize: 100, total: crowd.length }),
        );
      }
      if (u.includes("/api/v1/performance-reviews")) {
        return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 100, total: 0 }));
      }
      return Promise.resolve(jsonResponse(200, { items: [] }));
    });
    renderTab();

    // Page 1 carries the first 20 of 25; the bar offers a second page.
    expect(await screen.findByText("Crowd 00")).toBeInTheDocument();
    expect(screen.queryByText("Crowd 24")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(await screen.findByText("Crowd 24")).toBeInTheDocument();
    expect(screen.queryByText("Crowd 00")).toBeNull();
  });

  test("an empty timeline shows the pointer at the periods admin", async () => {
    setupMocks({ periods: [] });
    renderTab();
    expect(
      await screen.findByText(
        "There are no review periods yet — an administrator creates them under Config → Review periods.",
      ),
    ).toBeInTheDocument();
  });

  test("the Distribution toggle swaps the table for the rating charts and persists", async () => {
    setupMocks();
    renderTab();
    expect(await screen.findByText("Ann Alpha")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /distribution/i }));

    // The chart view replaces the table + pagination; the Attitude tab is active by default —
    // Ann's attitudeRating 4 lands in the 4-bucket, Zoe (no review) stays out of the bars.
    const chart = await screen.findByTestId("bar-chart");
    expect(chart).toHaveAttribute("data-buckets", "1:0,2:0,3:0,4:1,5:0,6:0");
    // Per-bar rating colors ride the data rows (the RatingBadge orange→green scale).
    expect(chart.getAttribute("data-colors")).toContain("orange.8");
    expect(chart.getAttribute("data-colors")).toContain("green.8");
    expect(screen.getByText("1 of 2 people rated")).toBeInTheDocument();
    // The custom tooltip labels bars with the scale wording.
    expect(screen.getByTestId("chart-tooltip")).toHaveTextContent("4 — Sometimes exceeds expectations");
    expect(screen.queryByText("No review yet")).toBeNull();
    expect(JSON.parse(localStorage.getItem("lettuce.viewSettings.dashboardReviews.view") ?? "null")).toBe("chart");

    // Category tabs switch the dataset: Skills carries Ann's 5.
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await waitFor(() =>
      expect(screen.getByTestId("bar-chart")).toHaveAttribute("data-buckets", "1:0,2:0,3:0,4:0,5:1,6:0"),
    );

    // Back to the table.
    fireEvent.click(screen.getByRole("radio", { name: /table/i }));
    expect(await screen.findByText("No review yet")).toBeInTheDocument();
    localStorage.removeItem("lettuce.viewSettings.dashboardReviews.view");
    localStorage.removeItem("lettuce.viewSettings.dashboardReviews.chartCategory");
  });

  test("the chart view without any rated person shows the empty message", async () => {
    setupMocks({ reviews: [] });
    localStorage.setItem("lettuce.viewSettings.dashboardReviews.view", JSON.stringify("chart"));
    renderTab();
    expect(await screen.findByText("No ratings in this selection yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("bar-chart")).toBeNull();
    localStorage.removeItem("lettuce.viewSettings.dashboardReviews.view");
  });

  test("the Quadrants toggle plots avatars at (x, y), groups same-cell people, lists the unrated", async () => {
    // Bob shares Ann's exact delivery/attitude pair — the same-cell grouping case.
    const bob = {
      ...REVIEW,
      id: 22, subordinateId: 9, subordinateName: "Zoe Zeta",
      attitudeRating: 4, deliveryRating: 3, skillsRating: null, overallRating: null,
    };
    const members = [...MEMBERS, { userId: 10, name: "Uma Unrated", email: "u@x", teamId: 1, teamName: "AAA" }];
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/api/v1/review-periods")) return Promise.resolve(jsonResponse(200, { items: PERIODS }));
      if (u.includes("/api/v1/teams/members")) {
        return Promise.resolve(jsonResponse(200, { items: members, page: 1, pageSize: 100, total: members.length }));
      }
      if (u.includes("/api/v1/performance-reviews")) {
        return Promise.resolve(jsonResponse(200, { items: [REVIEW, bob], page: 1, pageSize: 100, total: 2 }));
      }
      if (u.includes("/api/v1/dictionaries/")) return Promise.resolve(jsonResponse(200, { items: [] }));
      return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 20, total: 0 }));
    });
    renderTab();
    expect(await screen.findByText("Ann Alpha")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /quadrants/i }));

    // Defaults: X = Delivery, Y = Attitude. Ann (delivery 3, attitude 4) and Zoe (same pair)
    // sit TOGETHER in the (3, 4) cell as sibling links; Uma has no review — unrated caption.
    expect(await screen.findByLabelText("X axis", { selector: "input" })).toHaveValue("Delivery");
    expect(screen.getByLabelText("Y axis", { selector: "input" })).toHaveValue("Attitude");
    const cell = screen.getByTestId("quadrant-cell-3-4");
    expect(within(cell).getByRole("link", { name: "User details for Ann Alpha" })).toBeInTheDocument();
    expect(within(cell).getByRole("link", { name: "User details for Zoe Zeta" })).toBeInTheDocument();
    expect(screen.getByText("2 of 3 people rated")).toBeInTheDocument();
    expect(screen.getByText(/Not shown \(no rating for the picked axes\): Uma Unrated/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("lettuce.viewSettings.dashboardReviews.view") ?? "null")).toBe("quadrants");

    // Re-pick X = Skills: Ann (skills 5, attitude 4) moves; Zoe's skills are unset → unrated.
    fireEvent.click(screen.getByLabelText("X axis", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Skills" }));
    expect(await screen.findByTestId("quadrant-cell-5-4")).toBeInTheDocument();
    expect(within(screen.getByTestId("quadrant-cell-5-4")).getByRole("link", { name: "User details for Ann Alpha" })).toBeInTheDocument();
    expect(screen.getByText(/Uma Unrated, Zoe Zeta|Zoe Zeta, Uma Unrated/)).toBeInTheDocument();

    // Picking Y = Skills (the X value) SWAPS the axes — they can never coincide.
    fireEvent.click(screen.getByLabelText("Y axis", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Skills" }));
    await waitFor(() =>
      expect(screen.getByLabelText("X axis", { selector: "input" })).toHaveValue("Attitude"),
    );
    expect(screen.getByLabelText("Y axis", { selector: "input" })).toHaveValue("Skills");
    // Ann now plots at (attitude 4, skills 5).
    expect(screen.getByTestId("quadrant-cell-4-5")).toBeInTheDocument();
    expect(within(screen.getByTestId("quadrant-cell-4-5")).getByRole("link", { name: "User details for Ann Alpha" })).toBeInTheDocument();

    // Back to the table.
    fireEvent.click(screen.getByRole("radio", { name: /table/i }));
    expect(await screen.findByText("No review yet")).toBeInTheDocument();
    localStorage.removeItem("lettuce.viewSettings.dashboardReviews.view");
    localStorage.removeItem("lettuce.viewSettings.dashboardReviews.quadrantX");
    localStorage.removeItem("lettuce.viewSettings.dashboardReviews.quadrantY");
  });

  test("the quadrants view keeps the viewer's own avatar unlinked (self stays plain)", async () => {
    // The viewer (userId 7) rated themselves impossible — instead make the subordinate BE the
    // viewer id to exercise the self branch: Ann's userId 8 with the session user set to 8.
    localStorage.setItem(USER_ID_KEY, "8");
    setupMocks();
    localStorage.setItem("lettuce.viewSettings.dashboardReviews.view", JSON.stringify("quadrants"));
    renderTab();
    const cell = await screen.findByTestId("quadrant-cell-3-4");
    // Ann is the session user: an avatar, not a link.
    expect(within(cell).queryByRole("link")).toBeNull();
    expect(within(cell).getByRole("img", { name: "Ann Alpha" })).toBeInTheDocument();
    localStorage.removeItem("lettuce.viewSettings.dashboardReviews.view");
  });
});
