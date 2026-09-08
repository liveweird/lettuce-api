import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "../test/render";
import OrgChart from "./OrgChart";
import { jsonResponse } from "../test/http";

// happy-dom can't measure the canvas, so React Flow itself is mocked — but the mock renders
// the page's REAL custom node components (via nodeTypes), so PersonNode/TeamNode logic
// (aria labels, self/deleted gating, navigation) is exercised. The mockMarkdownEditor idiom.
vi.mock("@xyflow/react", () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any -- typing the mocked ReactFlow props against the real library's generic node/edge types isn't worth it in a test-only stub */
  ReactFlow: ({ nodes, edges, nodeTypes }: any) => (
    <div data-testid="canvas" data-edge-count={edges.length}>
      {nodes.map((n: any) => {
        const NodeComponent = nodeTypes[n.type];
        return <NodeComponent key={n.id} data={n.data} />;
      })}
    </div>
  ),
  /* eslint-enable @typescript-eslint/no-explicit-any */
  Handle: () => null,
  Controls: () => null,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
  MarkerType: { ArrowClosed: "arrowclosed" },
}));

const TOKEN_KEY = "lettuce.auth.token";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

const TEAMS = [
  { id: 1, name: "AAA", managerId: 10, managerName: "Manager AAA", managerDeleted: false },
  { id: 3, name: "CCC", managerId: 12, managerName: "Manager CCC", managerDeleted: false },
  { id: 9, name: "Orphan", managerId: 42, managerName: "Zed", managerDeleted: true },
];
const MEMBERS: Record<number, number[]> = { 1: [1], 3: [10], 9: [] };
const USERS = [
  { id: 1, name: "AAA One", email: "a1@x", roles: [] },
  { id: 10, name: "Manager AAA", email: "ma@x", roles: [] },
  { id: 12, name: "Manager CCC", email: "mc@x", roles: [] },
  { id: 50, name: "Floater", email: "fl@x", roles: [] }, // in no team — the unattached section
];

function mockApi(mockFetch: FetchMock, teams = TEAMS, users = USERS) {
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    const single = u.match(/^\/api\/v1\/teams\/(\d+)$/);
    if (single) {
      const id = Number(single[1]);
      const team = teams.find((t) => t.id === id)!;
      return Promise.resolve(
        jsonResponse(200, { id, name: team.name, managerId: team.managerId, memberIds: MEMBERS[id] ?? [] }),
      );
    }
    if (u.startsWith("/api/v1/teams?"))
      return Promise.resolve(jsonResponse(200, { items: teams, page: 1, pageSize: 100, total: teams.length }));
    if (u.startsWith("/api/v1/users?"))
      return Promise.resolve(jsonResponse(200, { items: users, page: 1, pageSize: 100, total: users.length }));
    return Promise.resolve(jsonResponse(404, {}));
  });
}

function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{location.pathname + location.search}</div>;
}

function renderOrg() {
  return renderWithProviders(
    <Routes>
      <Route path="/org" element={<OrgChart />} />
      <Route path="/users/:userId/details" element={<PathProbe />} />
      <Route path="/teams/:id/details" element={<PathProbe />} />
    </Routes>,
    { route: "/org" },
  );
}

describe("OrgChart page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(USER_ID_KEY, "12"); // the caller is Manager CCC
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("renders people and teams as nodes with the edges wired", async () => {
    mockApi(mockFetch);
    renderOrg();

    // The heading (with the tour anchor) renders immediately; nodes after the data lands.
    expect(screen.getByRole("heading", { name: "Org chart" })).toHaveAttribute("data-tour", "config-org");
    expect(await screen.findByText("AAA One")).toBeInTheDocument();
    expect(screen.getByText("Manager AAA")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Members of AAA" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Members of CCC" })).toBeInTheDocument();
    // 3 manages edges + 2 member edges.
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-edge-count", "5");
    // The teamless user renders too, under the section label, as an ordinary clickable node.
    expect(screen.getByText("Not in any team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "User details for Floater" })).toBeInTheDocument();
  });

  test("person nodes open the details view with the org origin — except self and deleted", async () => {
    mockApi(mockFetch);
    const user = userEvent.setup();
    renderOrg();

    // A deleted manager renders plain and dimmed, not clickable.
    expect(await screen.findByText(/Zed \(deleted\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "User details for Zed" })).not.toBeInTheDocument();
    // One's own node is plain too.
    expect(screen.queryByRole("button", { name: "User details for Manager CCC" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "User details for Manager AAA" }));
    expect(screen.getByTestId("probe")).toHaveTextContent("/users/10/details?name=Manager+AAA&from=org");
  });

  test("collapsing a team folds its members and their subtrees away; expanding restores them", async () => {
    mockApi(mockFetch);
    const user = userEvent.setup();
    renderOrg();

    expect(await screen.findByText("AAA One")).toBeInTheDocument();
    // A team with no members gets no toggle at all.
    expect(screen.queryByRole("button", { name: /team Orphan/ })).not.toBeInTheDocument();

    // Collapsing CCC hides its member (Manager AAA) AND cascades through the team they
    // manage: AAA and AAA One fold away too. Only the two manages edges into CCC/Orphan stay.
    await user.click(screen.getByRole("button", { name: "Collapse team CCC" }));
    expect(screen.queryByText("Manager AAA")).not.toBeInTheDocument();
    expect(screen.queryByText("AAA One")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Members of AAA" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Members of CCC" })).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument(); // the hidden-members count
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-edge-count", "2");

    await user.click(screen.getByRole("button", { name: "Expand team CCC" }));
    expect(screen.getByText("Manager AAA")).toBeInTheDocument();
    expect(screen.getByText("AAA One")).toBeInTheDocument();
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-edge-count", "5");
  });

  test("team nodes open the roster", async () => {
    mockApi(mockFetch);
    const user = userEvent.setup();
    renderOrg();

    await user.click(await screen.findByRole("button", { name: "Members of CCC" }));
    // The org origin rides along so the roster's back link returns to the chart.
    expect(screen.getByTestId("probe")).toHaveTextContent("/teams/3/details?from=org");
  });

  test("with no teams the people still render in the unattached section", async () => {
    mockApi(mockFetch, []);
    renderOrg();

    expect(await screen.findByText("Not in any team")).toBeInTheDocument();
    expect(screen.getByText("Floater")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "User details for AAA One" })).toBeInTheDocument();
    expect(screen.queryByText(/No teams yet/)).not.toBeInTheDocument();
  });

  test("shows the empty state only when there are no teams AND no users", async () => {
    mockApi(mockFetch, [], []);
    renderOrg();

    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument();
  });

  test("shows an alert when the composition fails", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(500, { error: "boom" })));
    renderOrg();

    expect(await screen.findByText("Failed to load the organization")).toBeInTheDocument();
  });
});
