import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "../test/render";
import ViewTeamKpi from "./ViewTeamKpi";
import { jsonResponse } from "../test/http";

// happy-dom can't measure the recharts canvas — stub the chart primitives and assert the
// props our chart component passes (the OrgChart @xyflow/react mock precedent). The LineChart
// stub additionally renders the custom tooltip content once, so the ghost-row filter and the
// date-formatted label are assertable.
vi.mock("@mantine/charts", () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any -- typing the mocked LineChart/ChartTooltip props against @mantine/charts' real generics isn't worth it in a test-only stub */
  LineChart: ({ data, referenceLines, tooltipProps, children }: any) => (
    <div
      data-testid="line-chart"
      data-points={data.length}
      data-reference-y={referenceLines?.[0]?.y}
      data-reference-overflow={referenceLines?.[0]?.ifOverflow}
    >
      {children}
      {tooltipProps?.content?.({
        label: Date.parse("2026-07-10"),
        payload: [
          { dataKey: "ts", name: "ts", value: Date.parse("2026-07-10") },
          { dataKey: "value", name: "value", value: 12 },
        ],
      })}
    </div>
  ),
  ChartTooltip: ({ label, payload }: any) => (
    <div
      data-testid="chart-tooltip"
      data-label={String(label)}
      data-row-keys={payload.map((p: any) => p.dataKey).join(",")}
    />
  ),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}));

// The good-zone ReferenceArea is a raw recharts child (v2.41.0) — stub it so the mocked
// LineChart can render it without a real chart context.
vi.mock("recharts", () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any -- typing the mocked ReferenceArea props against recharts' real generics isn't worth it in a test-only stub */
  ReferenceArea: (props: any) => (
    <div
      data-testid="good-zone"
      data-y1={props.y1}
      data-y2={props.y2}
      data-fill={props.fill}
      data-overflow={props.ifOverflow}
    />
  ),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}));

const TOKEN_KEY = "lettuce.auth.token";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

const KPI = {
  id: 5,
  teamId: 10,
  teamName: "Team AAA",
  teamDeleted: false,
  managerId: 7,
  managerName: "Me",
  creatorId: 7,
  creatorName: "Me",
  creatorDeleted: false,
  canManage: true,
  canRecordValues: true,
  createdAt: new Date(2026, 4, 1).getTime(),
  title: "Deploy weekly",
  description: "One production release per week",
  type: "NUMBER",
  targetValue: 52,
  targetDirection: "AT_LEAST",
  currentValue: 12,
  currentValueDate: "2026-07-10",
  status: "ACTIVE",
  summary: null,
  lastModified: new Date(2026, 6, 1).getTime(),
};

const VALUES = [
  { id: 2, date: "2026-07-10", value: 12 },
  { id: 1, date: "2026-07-01", value: 5 },
];

function mockApi(mockFetch: FetchMock, kpi: unknown = KPI, values: unknown[] = VALUES) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/v1/team-kpis/5" && !init?.method) return Promise.resolve(jsonResponse(200, kpi));
    if (u === "/api/v1/team-kpis/5/values" && !init?.method)
      return Promise.resolve(jsonResponse(200, { items: values }));
    if (u === "/api/v1/team-kpis/5/events") return Promise.resolve(jsonResponse(200, { items: [] }));
    if (init?.method === "POST") return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(jsonResponse(404, {}));
  });
}

function renderView(route = "/team-kpis/5/view") {
  return renderWithProviders(
    <Routes>
      <Route path="/team-kpis/:id/view" element={<ViewTeamKpi />} />
      <Route path="*" element={<div data-testid="elsewhere" />} />
    </Routes>,
    { route },
  );
}

describe("ViewTeamKpi", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(USER_ID_KEY, "7");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("General shows title, description, type, and target — no Current — plus the ACTIVE actions", async () => {
    mockApi(mockFetch);
    renderView();

    expect(await screen.findByText("Deploy weekly")).toBeInTheDocument();
    expect(screen.getByText("Team AAA")).toBeInTheDocument();
    // Manager AND Creator both render "You" here — the caller set the KPI for their own team.
    expect(screen.getAllByText("You")).toHaveLength(2);
    expect(screen.getByText("One production release per week")).toBeInTheDocument();
    expect(screen.getByText("Number")).toBeInTheDocument();
    // The target renders with its direction glyph (v2.41.0).
    expect(screen.getByText("≥ 52")).toBeInTheDocument();
    // The current value moved to the KPI data tab — General no longer shows it.
    expect(screen.queryByText("Current")).not.toBeInTheDocument();
    // The four tabs.
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "KPI data" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Graph" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toBeInTheDocument();
    // ACTIVE offers Return-to-draft + Archive; the Edit link is DRAFT-only now.
    expect(screen.getByRole("button", { name: "Return to draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  test("a DRAFT offers the Edit link and Activate for the manager", async () => {
    mockApi(mockFetch, { ...KPI, status: "DRAFT" }, []);
    renderView();

    expect(await screen.findByText("Deploy weekly")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
  });

  test("the KPI data tab lists the points newest first with the manager's edit controls", async () => {
    mockApi(mockFetch);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("tab", { name: "KPI data" }));
    expect(await screen.findByRole("button", { name: "Add value" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1); // skip the header row
    expect(within(rows[0]).getByText("12")).toBeInTheDocument();
    expect(within(rows[1]).getByText("5")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Edit the value of/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Remove the value of/ })).toHaveLength(2);
  });

  test("a member edits the KPI data but gets no lifecycle actions (v2.26.0)", async () => {
    // The server grants a team member canRecordValues but never canManage.
    mockApi(mockFetch, {
      ...KPI,
      managerId: 99,
      managerName: "Mona",
      canManage: false,
      canRecordValues: true,
    });
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("tab", { name: "KPI data" }));
    expect(await screen.findByText("12")).toBeInTheDocument();
    // Recording data is the team's shared work now — the add row and per-row controls show.
    expect(screen.getByRole("button", { name: "Add value" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Edit the value of/ })).toHaveLength(2);
    // But the lifecycle stays the manager's (and chain's): no actions, no Edit link.
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  test("a chain viewer without team membership sees the KPI data read-only", async () => {
    // HR (or any read-granted caller outside the value writers): both capabilities false.
    mockApi(mockFetch, {
      ...KPI,
      managerId: 99,
      managerName: "Mona",
      canManage: false,
      canRecordValues: false,
    });
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("tab", { name: "KPI data" }));
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add value" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit the value of/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  test("the manager on a DRAFT sees the data read-only with the inactive hint", async () => {
    mockApi(mockFetch, { ...KPI, status: "DRAFT" });
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("tab", { name: "KPI data" }));
    expect(
      await screen.findByText("Data points can be changed while the KPI is active."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add value" })).not.toBeInTheDocument();
  });

  test("the Graph tab plots the data points with the always-visible target line and a clean tooltip", async () => {
    mockApi(mockFetch);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("tab", { name: "Graph" }));
    const chart = await screen.findByTestId("line-chart");
    expect(chart).toHaveAttribute("data-points", "2");
    expect(chart).toHaveAttribute("data-reference-y", "52");
    // The target line extends the y-domain instead of being silently discarded.
    expect(chart).toHaveAttribute("data-reference-overflow", "extendDomain");
    // The custom tooltip filters the recharts numeric-x ghost row ("ts") and formats the
    // numeric label as a date.
    const tooltip = screen.getByTestId("chart-tooltip");
    expect(tooltip).toHaveAttribute("data-row-keys", "value");
    expect(tooltip.getAttribute("data-label")).toMatch(/2026/);
    // The good-zone tint (v2.41.0): AT_LEAST anchors y1 at the target with the far bound
    // pushed past the domain, clipped by ifOverflow="hidden" — teal.
    const zone = screen.getByTestId("good-zone");
    expect(zone).toHaveAttribute("data-y1", "52");
    expect(Number(zone.getAttribute("data-y2"))).toBeGreaterThan(52);
    expect(zone.getAttribute("data-fill")).toContain("teal");
    expect(zone).toHaveAttribute("data-overflow", "hidden");
    // The hint names the target with its direction glyph.
    expect(screen.getByText(/≥ 52/)).toBeInTheDocument();
  });

  test("an AT_MOST KPI tints the graph below the target line", async () => {
    mockApi(mockFetch, { ...KPI, targetDirection: "AT_MOST" });
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("tab", { name: "Graph" }));
    const zone = await screen.findByTestId("good-zone");
    expect(zone).toHaveAttribute("data-y2", "52");
    expect(Number(zone.getAttribute("data-y1"))).toBeLessThan(52);
    expect(screen.getByText(/≤ 52/)).toBeInTheDocument();
  });

  test("the Graph tab shows the empty note when the KPI has no data points", async () => {
    mockApi(mockFetch, KPI, []);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("tab", { name: "Graph" }));
    expect(await screen.findByText(/No data points yet/)).toBeInTheDocument();
  });

  test("archiving collects the mandatory summary and posts the archive action", async () => {
    mockApi(mockFetch);
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Deploy weekly");

    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    // Blank summary refused client-side.
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("A summary is required to archive a KPI")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Summary/), "Great year");
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => {
      const archive = mockFetch.mock.calls.find(([u]) => String(u).endsWith("/archive"));
      expect(archive).toBeDefined();
      expect(JSON.parse((archive![1] as RequestInit).body as string)).toEqual({ summary: "Great year" });
    });
  });

  test("the ARCHIVED status offers Reopen and shows the summary", async () => {
    mockApi(mockFetch, { ...KPI, status: "ARCHIVED", summary: "Wrapped up" });
    renderView();

    expect(await screen.findByText("Wrapped up")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  test("a 403 renders the permission error", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(403, { title: "Forbidden" })));
    renderView();
    expect(await screen.findByText("You may not view this team KPI.")).toBeInTheDocument();
  });
});
