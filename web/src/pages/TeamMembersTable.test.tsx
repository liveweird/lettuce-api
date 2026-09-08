import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, renderWithProviders, screen, waitFor, within } from "../test/render";
import TeamMembersTable from "./TeamMembersTable";
import { jsonResponse } from "../test/http";

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

type TeamMemberItem = {
  userId: number;
  name: string;
  email: string;
  teamId: number;
  teamName: string;
  lastOneOnOneDate?: string | null;
  lastOneOnOneOpenItems?: number | null;
  lastFeedbackAt?: number | null;
  lastFeedbackGivenAt?: number | null;
  lastFeedbackReceivedAt?: number | null;
  activeGoalCount?: number | null;
  lastReviewId?: number | null;
  lastReviewPeriodStartMonth?: string | null;
  lastReviewPeriodEndMonth?: string | null;
  lastReviewStatus?: "DRAFT" | "CALIBRATION" | "PUBLISHED" | null;
  careerPath?: { id: number; values: { en: string; pl?: string } } | null;
  careerSpecialization?: { id: number; values: { en: string; pl?: string } } | null;
  seniorityLevel?: { id: number; values: { en: string; pl?: string } } | null;
  nextVacationStart?: string | null;
  daysOffRemaining?: number | null;
};


function membersPage(items: TeamMemberItem[], total = items.length): Response {
  return jsonResponse(200, { items, page: 1, pageSize: 20, total });
}

const SEED_MEMBERS: TeamMemberItem[] = [
  { userId: 10, name: "Alice Adams", email: "alice@x.test", teamId: 3, teamName: "Platform" },
  { userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support" },
  // Same user in a second shared team — must render as its own row.
  { userId: 10, name: "Alice Adams", email: "alice@x.test", teamId: 4, teamName: "Support" },
];

const SEED_TEAMS = [
  { id: 3, name: "Platform", managerId: 1, managerName: "Mona", managerDeleted: false },
  { id: 4, name: "Support", managerId: 1, managerName: "Mona", managerDeleted: false },
];

function teamsPage(): Response {
  return jsonResponse(200, { items: SEED_TEAMS, page: 1, pageSize: 100, total: SEED_TEAMS.length });
}

function setupMocks(
  mockFetch: FetchMock,
  response: Response = membersPage(SEED_MEMBERS),
  ownPlans: Array<{ id: number; userId: number; lastReviewedAt: number }> = [],
) {
  mockFetch.mockImplementation((url: string) => {
    const path = String(url);
    if (path.startsWith("/api/v1/teams/members")) return Promise.resolve(response.clone());
    if (path.startsWith("/api/v1/succession-plans")) {
      return Promise.resolve(
        jsonResponse(200, { items: ownPlans, page: 1, pageSize: 100, total: ownPlans.length }),
      );
    }
    if (path.startsWith("/api/v1/teams")) return Promise.resolve(teamsPage());
    return Promise.resolve(jsonResponse(404, {}));
  });
}

function memberUrls(mockFetch: FetchMock): string[] {
  return mockFetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/v1/teams/members"));
}

// v1.51.0: the feedback and 1:1 card actions live behind per-card topic dropdowns — open
// the trigger, then assert on its role=menuitem entries (the Users.test.tsx idiom).
async function openCardMenu(name: RegExp | string) {
  await userEvent.setup().click(await screen.findByRole("button", { name }));
}

// The exact timestamp behind a relative phrase — the localized formatDateTime (v3.5.0).
const stamp = (ms: number) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));

describe("TeamMembersTable", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLE_KEY, "[]");
    localStorage.setItem(USER_ID_KEY, "7");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("renders person cards with name, email and team badges; fetches view=member with sort=name", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    expect(await screen.findByText("Bob Brown")).toBeInTheDocument();
    expect(screen.getByText("bob@x.test")).toBeInTheDocument();
    // Alice is in two shared teams -> ONE card with both team badges (rows are deduped).
    expect(screen.getAllByText("Alice Adams")).toHaveLength(1);
    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.getAllByText("Support")).toHaveLength(2); // Alice's badge + Bob's badge
    // Badges link to the team-details view (v2.5.4).
    expect(screen.getByRole("link", { name: "Team details for Platform" })).toHaveAttribute(
      "href",
      "/teams/3/details",
    );

    const urls = memberUrls(mockFetch);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain("view=member");
    expect(urls[0]).toContain("sort=name");
  });

  test("fetches view=managed when configured", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    await screen.findByText("Bob Brown");
    expect(memberUrls(mockFetch)[0]).toContain("view=managed");
  });

  test("renders a Provide feedback menu item per row pointing at /feedback/new", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    // One Feedback dropdown per person (Alice's two memberships collapse into one card).
    expect(await screen.findAllByRole("button", { name: /feedback actions for/i })).toHaveLength(2);
    await openCardMenu(/feedback actions for bob brown/i);
    const item = await screen.findByRole("menuitem", { name: /provide feedback to bob brown/i });
    expect(item).toHaveAttribute(
      "href",
      `/feedback/new?subjectId=11&back=${encodeURIComponent("/?tab=peers")}`,
    );
  });

  test("managed view adds a Request feedback menu item per row pointing at /feedback/request", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    // One Feedback dropdown per person (Alice's two memberships collapse into one card).
    expect(await screen.findAllByRole("button", { name: /feedback actions for/i })).toHaveLength(2);
    await openCardMenu(/feedback actions for bob brown/i);
    const item = await screen.findByRole("menuitem", { name: /request feedback about bob brown/i });
    expect(item).toHaveAttribute(
      "href",
      `/feedback/request?subjectId=11&back=${encodeURIComponent("/?tab=subordinates")}`,
    );
  });

  test("managed view adds an Ask for feedback menu item per row pointing at /feedback/ask", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    await openCardMenu(/feedback actions for bob brown/i);
    const item = await screen.findByRole("menuitem", { name: /ask bob brown for feedback/i });
    expect(item).toHaveAttribute(
      "href",
      `/feedback/ask?providerId=11&back=${encodeURIComponent("/?tab=subordinates")}`,
    );
  });

  test("member view adds an Ask for feedback menu item per row pointing at /feedback/ask", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await openCardMenu(/feedback actions for bob brown/i);
    const item = await screen.findByRole("menuitem", { name: /ask bob brown for feedback/i });
    expect(item).toHaveAttribute(
      "href",
      `/feedback/ask?providerId=11&back=${encodeURIComponent("/?tab=peers")}`,
    );
  });

  test("member view does not render the Request feedback action", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await openCardMenu(/feedback actions for bob brown/i);
    await screen.findByRole("menuitem", { name: /provide feedback to bob brown/i });
    expect(screen.queryByRole("menuitem", { name: /request feedback about/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /request feedback about/i })).toBeNull();
  });

  test("member view adds a Feedback list menu item per row pointing at the per-user screen", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await openCardMenu(/feedback actions for bob brown/i);
    const item = await screen.findByRole("menuitem", { name: /feedbacks with bob brown/i });
    expect(item).toHaveAttribute(
      "href",
      "/users/11/feedbacks?name=Bob+Brown&from=peers",
    );
  });

  test("managed view also renders a Feedback list menu item per row, scoped from=subordinates", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    await openCardMenu(/feedback actions for bob brown/i);
    const item = await screen.findByRole("menuitem", { name: /feedbacks with bob brown/i });
    expect(item).toHaveAttribute(
      "href",
      "/users/11/feedbacks?name=Bob+Brown&from=subordinates",
    );
  });

  test("managed view (direct mode) adds a 1:1 dropdown per row; peers never get one", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    // One 1:1 dropdown per person (Alice's two memberships collapse into one card).
    expect(await screen.findAllByRole("button", { name: /1:1 actions for/i })).toHaveLength(2);
    await openCardMenu("1:1 actions for Bob Brown");
    const item = await screen.findByRole("menuitem", { name: "1:1 meetings with Bob Brown" });
    expect(item).toHaveAttribute(
      "href",
      "/users/11/one-on-ones?name=Bob%20Brown&from=subordinates",
    );

    // Same gate: the create shortcut with the subordinate prefilled and the dashboard as back.
    expect(screen.getByRole("menuitem", { name: "New 1:1 with Bob Brown" })).toHaveAttribute(
      "href",
      `/one-on-ones/new?subordinateId=11&back=${encodeURIComponent("/?tab=subordinates")}`,
    );

    cleanup();
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);
    await screen.findByText("Bob Brown");
    expect(screen.queryByRole("button", { name: /1:1 actions for/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /1:1 meetings with/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /new 1:1 with/i })).toBeNull();
  });

  test("managed view (direct mode) adds a Goals link per row; peers never get one", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    const link = await screen.findByRole("link", { name: "Goals for Bob Brown" });
    expect(link).toHaveAttribute("href", "/users/11/goals?name=Bob%20Brown&from=subordinates");
    expect(screen.getAllByRole("link", { name: /goals for/i })).toHaveLength(2);

    cleanup();
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);
    await screen.findByText("Bob Brown");
    expect(screen.queryByRole("link", { name: /goals for/i })).toBeNull();
  });

  test("managed view (direct mode) adds a Performance-reviews link per row; peers and the all scope never do", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    const link = await screen.findByRole("link", { name: "Performance reviews of Bob Brown" });
    expect(link).toHaveAttribute(
      "href",
      "/users/11/performance-reviews?name=Bob%20Brown&from=subordinates",
    );
    expect(screen.getAllByRole("link", { name: /performance reviews of/i })).toHaveLength(2);
    // Its Performance-section sibling (v2.38.0): the per-report journal drill-down.
    expect(screen.getByRole("link", { name: "Impact log of Bob Brown" })).toHaveAttribute(
      "href",
      "/users/11/impact-log?name=Bob%20Brown&from=subordinates",
    );

    // The all-reports scope hides it — creation (the drill-down's New review) needs a direct
    // report. The Impact log button stays: journal reads are chain-wide (the daysOff shape).
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByLabelText("Reports", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "All reports (including indirect)" }));
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /performance reviews of/i })).toBeNull();
    });
    expect(screen.getAllByRole("link", { name: /impact log of/i }).length).toBeGreaterThan(0);

    cleanup();
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);
    await screen.findByText("Bob Brown");
    expect(screen.queryByRole("link", { name: /performance reviews of/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /impact log of/i })).toBeNull();
  });

  test("the pinned team embedding addresses drill-downs with the team origin - Impact log included", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" teamId={4} emptyMessage="No team members" />);

    // Without teamId the origin degrades to "managers" and UserImpactLog bounces the manager
    // to their own journal — the v2.40.1 fix gave userImpactLogLink the teamId its siblings
    // always had.
    expect(await screen.findByRole("link", { name: "Impact log of Bob Brown" })).toHaveAttribute(
      "href",
      "/users/11/impact-log?name=Bob%20Brown&from=team&teamId=4",
    );
    expect(screen.getByRole("link", { name: "Performance reviews of Bob Brown" })).toHaveAttribute(
      "href",
      "/users/11/performance-reviews?name=Bob%20Brown&from=team&teamId=4",
    );
  });

  test("peer cards carry the career column - a null seniority stays hidden (v2.25.0)", async () => {
    // The server blanks a peer's seniority (private outside the chain), so null is
    // ambiguous — the row is omitted rather than showing a misleading "Not set".
    setupMocks(
      mockFetch,
      membersPage([
        {
          ...SEED_MEMBERS[1],
          careerPath: { id: 11, values: { en: "System Analyst" } },
          careerSpecialization: { id: 21, values: { en: "Java" } },
          seniorityLevel: null,
        },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No team members" />);

    expect(await screen.findByText("Path")).toBeInTheDocument();
    expect(screen.getByText("System Analyst")).toBeInTheDocument();
    expect(screen.getByText("Java")).toBeInTheDocument();
    expect(screen.queryByText("Seniority")).toBeNull();
    expect(screen.queryByText("Not set")).toBeNull();
    // The peer stats column still renders beside it.
    expect(screen.getByText("Feedback from me")).toBeInTheDocument();
  });

  test("subordinate cards keep the Not set cue for an unset seniority (v2.25.0)", async () => {
    // On view=managed the caller IS the chain — a null seniority genuinely means unset,
    // so the orange cue stays truthful and renders.
    setupMocks(
      mockFetch,
      membersPage([
        {
          ...SEED_MEMBERS[1],
          careerPath: { id: 11, values: { en: "System Analyst" } },
          careerSpecialization: { id: 21, values: { en: "Java" } },
          seniorityLevel: null,
        },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No reports" />);

    expect(await screen.findByText("Seniority")).toBeInTheDocument();
    expect(screen.getAllByText("Not set")).toHaveLength(1);
  });

  test("peer cards show the next vacation but never a budget or Days off button", async () => {
    setupMocks(
      mockFetch,
      membersPage([
        { ...SEED_MEMBERS[0], nextVacationStart: "2026-09-14" },
        { ...SEED_MEMBERS[1], nextVacationStart: null },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No team members" />);

    expect(await screen.findAllByText("Next vacation")).toHaveLength(2);
    expect(screen.getByText("Sep 14, 2026")).toBeInTheDocument();
    expect(screen.getByText("none planned")).toBeInTheDocument();
    expect(screen.queryByText("Days-off budget left")).toBeNull();
    expect(screen.queryByRole("link", { name: /days off of/i })).toBeNull();
    // The Days off section caption (v1.46.0) shows on each peer card (vacation-only);
    // the Performance section never does — peer rows carry no review stat or button.
    expect(screen.getAllByText("Days off")).toHaveLength(2);
    expect(screen.queryByText("Performance")).toBeNull();
  });

  test("managed cards carry a Days off drill-down link", async () => {
    setupMocks(mockFetch, membersPage([SEED_MEMBERS[1]]));
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    const link = await screen.findByRole("link", { name: /days off of bob brown/i });
    expect(link.getAttribute("href")).toContain("/users/11/days-off");
    expect(link.getAttribute("href")).toContain("from=subordinates");
  });

  test("managed cards link the viewer's own OPEN succession plan; plan-less rows stay bare (v2.47.0)", async () => {
    setupMocks(mockFetch, membersPage(SEED_MEMBERS), [
      { id: 9, userId: 11, lastReviewedAt: Date.now() - 86_400_000 },
    ]);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    const link = await screen.findByRole("link", { name: "Succession plan for Bob Brown" });
    expect(link.getAttribute("href")).toContain("/succession/9/view");
    // Alice has no plan in the pool — no button on her card.
    expect(screen.queryByRole("link", { name: "Succession plan for Alice Adams" })).toBeNull();
    // Bob's card carries the reviewed stat row (v2.47.2); it's the only one.
    expect(screen.getAllByText("Succession reviewed")).toHaveLength(1);
  });

  test("the peers view never shows a succession-plan button (the pool never even loads)", async () => {
    setupMocks(mockFetch, membersPage([SEED_MEMBERS[1]]), [
      { id: 9, userId: 11, lastReviewedAt: Date.now() },
    ]);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No team members" />);

    await screen.findByText("Bob Brown");
    expect(screen.queryByRole("link", { name: "Succession plan for Bob Brown" })).toBeNull();
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).startsWith("/api/v1/succession-plans")),
    ).toBe(false);
  });

  test("the all-reports scope keeps the career column even though the stats disappear", async () => {
    setupMocks(
      mockFetch,
      membersPage([{ ...SEED_MEMBERS[1], careerPath: { id: 11, values: { en: "QA Engineer" } } }]),
    );
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);
    await screen.findByText("Path");

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(screen.getByLabelText("Reports", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "All reports (including indirect)" }));

    // Directional stats gone (indirect rows are unmarked), career rows stay.
    await waitFor(() => {
      expect(screen.queryByText("Last 1:1")).toBeNull();
    });
    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("QA Engineer")).toBeInTheDocument();
    // Sections (v1.46.0): Profile + the buttons-only Collaboration remain; the Performance
    // section drops its stats and Reviews button but stays for the chain-wide Impact log
    // drill-down (v2.38.0 — the Days off shape, v2.32.0).
    expect(screen.getByText("Profile")).toBeInTheDocument();
    // The actions live in the icon footer since v3.4.0, so a section without stats no
    // longer renders just to host its buttons: no Collaboration/Performance/Days off
    // captions at the all-reports scope, while the drill-downs themselves stay.
    expect(screen.queryByText("Collaboration")).toBeNull();
    expect(screen.queryByText("Performance")).toBeNull();
    expect(screen.queryByText("Days off")).toBeNull();
    expect(screen.queryByRole("link", { name: /performance reviews of/i })).toBeNull();
    expect(screen.getByRole("link", { name: /impact log of/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Days off of Bob Brown")).toBeInTheDocument();
  });

  test("switching the reports scope to all hides the Goals buttons like the 1:1 ones", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);
    await screen.findByRole("link", { name: "Goals for Bob Brown" });

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(screen.getByLabelText("Reports", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "All reports (including indirect)" }));
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /goals for/i })).toBeNull();
    });
  });

  test("switching the reports scope to all hides the 1:1 dropdown (indirect rows are unmarked)", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    await screen.findByRole("button", { name: "1:1 actions for Bob Brown" });
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(screen.getByLabelText("Reports", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "All reports (including indirect)" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /1:1 actions for/i })).toBeNull();
    });
    expect(screen.queryByRole("link", { name: /1:1 meetings with/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /new 1:1 with/i })).toBeNull();
  });

  test("typing in the Name filter triggers a debounced refetch and the clear button resets it", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.type(screen.getByLabelText("Name"), "ali");

    await waitFor(
      () => {
        expect(memberUrls(mockFetch).some((url) => url.includes("name=ali"))).toBe(true);
      },
      { timeout: 1500 },
    );

    await user.click(screen.getByLabelText("Clear name filter"));
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  test("filters are collapsed by default and the toggle reveals them", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    const toggle = screen.getByRole("button", { name: /filters/i });
    // Collapsed by default — the toggle reports it and the space-eating filter row is hidden.
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.type(screen.getByLabelText("Name"), "ali");
    expect(screen.getByLabelText("Name")).toHaveValue("ali");

    // Toggling again collapses it.
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("the Filters toggle shows a badge counting the active filters", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    const toggle = screen.getByRole("button", { name: /filters/i });
    // No filters set → no badge.
    expect(within(toggle).queryByText("1")).not.toBeInTheDocument();

    await user.click(toggle);
    await user.type(screen.getByLabelText("Name"), "ali");
    expect(within(toggle).getByText("1")).toBeInTheDocument();
  });

  test("typing in the Email filter adds email=", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.type(screen.getByLabelText("Email"), "bob@");
    await waitFor(
      () => {
        expect(memberUrls(mockFetch).some((url) => url.includes("email=bob%40"))).toBe(true);
      },
      { timeout: 1500 },
    );
  });

  test("the Team dropdown lists all teams", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));

    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(screen.getByLabelText("Team", { selector: "input" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Platform", "Support"]);
  });

  test("picking a team filters by teamId and clearing removes the filter", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));

    fireEvent.click(screen.getByLabelText("Team", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Support" }));
    await waitFor(() => {
      expect(memberUrls(mockFetch).some((url) => url.includes("teamId=4"))).toBe(true);
    });

    const requestsBeforeClear = memberUrls(mockFetch).length;
    fireEvent.click(screen.getByLabelText("Clear team filter"));
    await waitFor(() => {
      const later = memberUrls(mockFetch).slice(requestsBeforeClear);
      expect(later.length).toBeGreaterThan(0);
      expect(later.every((url) => !url.includes("teamId="))).toBe(true);
    });
  });

  test("managed view offers the reports-scope filter; switching to all reports adds includeIndirect=true", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    await screen.findByText("Bob Brown");
    // Default: direct reports only — the request carries no includeIndirect param.
    expect(memberUrls(mockFetch).every((url) => !url.includes("includeIndirect"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    const scope = screen.getByLabelText("Reports", { selector: "input" });
    expect(scope).toHaveValue("Direct reports only");

    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(scope);
    fireEvent.click(await screen.findByRole("option", { name: "All reports (including indirect)" }));
    await waitFor(() => {
      expect(memberUrls(mockFetch).some((url) => url.includes("includeIndirect=true"))).toBe(true);
    });
  });

  test("member view has no reports-scope filter", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    await screen.findByLabelText("Name");
    expect(screen.queryByLabelText("Reports", { selector: "input" })).not.toBeInTheDocument();
  });

  test("the sort control sorts by team; the direction toggle descends", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(screen.getByLabelText("Sort by", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Team" }));
    await waitFor(() => {
      expect(memberUrls(mockFetch).some((url) => url.includes("sort=teamName"))).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Toggle sort direction" }));
    await waitFor(() => {
      expect(memberUrls(mockFetch).some((url) => url.includes("sort=-teamName"))).toBe(true);
    });
  });

  test("pagination and page size controls update the query", async () => {
    setupMocks(mockFetch, membersPage(SEED_MEMBERS, 45));
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    expect(screen.getByText("45 total")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => {
      expect(memberUrls(mockFetch).some((url) => url.includes("page=2"))).toBe(true);
    });

    fireEvent.click(screen.getByLabelText("Rows per page", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "40 / page" }));
    await waitFor(() => {
      const url = memberUrls(mockFetch).find((u) => u.includes("pageSize=40"));
      expect(url).toBeDefined();
      expect(url).toContain("page=1");
    });
  });

  test("shows the configured empty state", async () => {
    setupMocks(mockFetch, membersPage([]));
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    expect(await screen.findByText("No team members")).toBeInTheDocument();
  });

  test("shows an error alert when the request fails", async () => {
    setupMocks(mockFetch, jsonResponse(500, { error: "internal", message: "boom" }));
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    expect(await screen.findByText(/failed to load team members/i)).toBeInTheDocument();
  });

  test("managed view renders the per-subordinate stats: relative 1:1 age, open-items badge, last feedback", async () => {
    // Fake only Date so Intl.RelativeTimeFormat is deterministic while waitFor keeps real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-12T12:00:00"));
    try {
      setupMocks(
        mockFetch,
        membersPage([
          {
            userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
            lastOneOnOneDate: "2026-07-01",
            lastOneOnOneOpenItems: 2,
            lastFeedbackAt: new Date("2026-07-10T12:00:00").getTime(),
            activeGoalCount: 3,
            lastReviewId: 7,
            lastReviewPeriodStartMonth: "2026-01",
            lastReviewPeriodEndMonth: "2026-06",
            lastReviewStatus: "CALIBRATION",
            nextVacationStart: "2026-08-10",
            daysOffRemaining: 17.5,
          },
        ]),
      );
      renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

      expect(await screen.findByText("Last 1:1")).toBeInTheDocument();
      expect(screen.getByText("last week")).toBeInTheDocument(); // 11 days ago, week unit
      expect(screen.getByText("2 open items")).toBeInTheDocument();
      expect(screen.getByText("Last feedback")).toBeInTheDocument();
      expect(screen.getByText("2 days ago")).toBeInTheDocument();
      // Exact values ride in the title attributes.
      expect(screen.getByText("last week")).toHaveAttribute("title", "Jul 1, 2026");
      expect(screen.getByText("2 days ago")).toHaveAttribute("title", stamp(new Date(2026, 6, 10, 12, 0).getTime()));
      expect(screen.getByText("Active goals")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
      // The last authored review (v1.34.0): period range + status badge. The card uses the
      // short-month form (v3.8.2) so the range fits on one line beside the status badge.
      expect(screen.getByText("Last review")).toBeInTheDocument();
      expect(screen.getByText("Jan 2026 – Jun 2026")).toBeInTheDocument();
      expect(screen.getByText("Calibration")).toBeInTheDocument();
      // The days-off pair (v1.44.0).
      expect(screen.getByText("Next vacation")).toBeInTheDocument();
      expect(screen.getByText("Aug 10, 2026")).toBeInTheDocument();
      expect(screen.getByText("Days-off budget left")).toBeInTheDocument();
      expect(screen.getByText("17.5")).toBeInTheDocument();
      // All four labeled sections (v1.46.0); "Days off" matches the caption AND the
      // drill-down button's text on a subordinate card.
      expect(screen.getByText("Profile")).toBeInTheDocument();
      expect(screen.getByText("Collaboration")).toBeInTheDocument();
      expect(screen.getByText("Performance")).toBeInTheDocument();
      // The section divider only — the drill-down is an icon in the footer (v3.4.0).
      expect(screen.getAllByText("Days off")).toHaveLength(1);
      expect(screen.queryByText("never")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("stats without data render as never, with no open-items badge", async () => {
    setupMocks(
      mockFetch,
      membersPage([
        {
          userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
          lastOneOnOneDate: null, lastOneOnOneOpenItems: null, lastFeedbackAt: null,
          activeGoalCount: null,
        },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    // 1:1, feedback, last review (v1.34.0), and the budget (v1.44.0) all read "never"
    // without data; the next vacation has its own wording.
    expect(await screen.findAllByText("never")).toHaveLength(4);
    expect(screen.getByText("none planned")).toBeInTheDocument();
    expect(screen.queryByText(/open item/)).toBeNull();
    // The goal count is a number, never "never" — absent renders as an explicit 0.
    expect(screen.getByText("Active goals")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  test("zero open items renders an explicit 0 badge, not never", async () => {
    setupMocks(
      mockFetch,
      membersPage([
        {
          userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
          lastOneOnOneDate: "2026-07-01", lastOneOnOneOpenItems: 0, lastFeedbackAt: null,
        },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    expect(await screen.findByText("0 open items")).toBeInTheDocument();
    // The feedback, last-review, and budget stats are empty; the 1:1 row is not.
    expect(screen.getAllByText("never")).toHaveLength(3);
  });

  test("a two-team subordinate's single card renders the stats once", async () => {
    const stats = {
      lastOneOnOneDate: "2026-07-01", lastOneOnOneOpenItems: 1,
      lastFeedbackAt: new Date("2026-07-10T12:00:00").getTime(),
    };
    setupMocks(
      mockFetch,
      membersPage([
        { userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support", ...stats },
        { userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 3, teamName: "Platform", ...stats },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    expect(await screen.findAllByText("Bob Brown")).toHaveLength(1);
    expect(screen.getAllByText("1 open item")).toHaveLength(1);
    expect(screen.getAllByText("Last feedback")).toHaveLength(1);
  });

  test("the member view ignores 1:1/directional fields even when rows carry them", async () => {
    setupMocks(
      mockFetch,
      membersPage([
        {
          userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
          lastOneOnOneDate: "2026-07-01", lastOneOnOneOpenItems: 1, lastFeedbackAt: 1780000000000,
          activeGoalCount: 2,
        },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    expect(screen.queryByText("Last 1:1")).toBeNull();
    expect(screen.queryByText("Last feedback")).toBeNull();
    expect(screen.queryByText(/open item/)).toBeNull();
    expect(screen.queryByText("Active goals")).toBeNull();
    // The peer stats render off their own (absent → never) fields instead.
    expect(screen.getByText("Feedback from me")).toBeInTheDocument();
    expect(screen.getAllByText("never")).toHaveLength(2);
  });

  test("member view renders the two peer feedback stats with relative times", async () => {
    // Fake only Date so Intl.RelativeTimeFormat is deterministic while waitFor keeps real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-12T12:00:00"));
    try {
      setupMocks(
        mockFetch,
        membersPage([
          {
            userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
            lastFeedbackGivenAt: new Date("2026-07-10T12:00:00").getTime(),
            lastFeedbackReceivedAt: new Date("2026-07-05T12:00:00").getTime(),
          },
        ]),
      );
      renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

      expect(await screen.findByText("Feedback from me")).toBeInTheDocument();
      expect(screen.getByText("2 days ago")).toBeInTheDocument();
      expect(screen.getByText("Feedback from them")).toBeInTheDocument();
      expect(screen.getByText("last week")).toBeInTheDocument();
      // Exact values ride in the title attributes.
      expect(screen.getByText("2 days ago")).toHaveAttribute("title", stamp(new Date(2026, 6, 10, 12, 0).getTime()));
      expect(screen.getByText("last week")).toHaveAttribute("title", stamp(new Date(2026, 6, 5, 12, 0).getTime()));
      expect(screen.queryByText("never")).toBeNull();
      // No 1:1 row and no direction-neutral feedback row on peer cards.
      expect(screen.queryByText("Last 1:1")).toBeNull();
      expect(screen.queryByText("Last feedback")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("peer stats without data render as never", async () => {
    setupMocks(
      mockFetch,
      membersPage([
        {
          userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
          lastFeedbackGivenAt: null, lastFeedbackReceivedAt: null,
        },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    expect(await screen.findAllByText("never")).toHaveLength(2);
    expect(screen.queryByText(/open item/)).toBeNull();
  });

  test("a two-team peer's single card renders the peer stats once", async () => {
    const stats = {
      lastFeedbackGivenAt: new Date("2026-07-10T12:00:00").getTime(),
      lastFeedbackReceivedAt: new Date("2026-07-05T12:00:00").getTime(),
    };
    setupMocks(
      mockFetch,
      membersPage([
        { userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support", ...stats },
        { userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 3, teamName: "Platform", ...stats },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    expect(await screen.findAllByText("Bob Brown")).toHaveLength(1);
    expect(screen.getAllByText("Feedback from me")).toHaveLength(1);
    expect(screen.getAllByText("Feedback from them")).toHaveLength(1);
  });

  test("switching the reports scope to all hides the stats (indirect rows are unmarked)", async () => {
    setupMocks(
      mockFetch,
      membersPage([
        {
          userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
          lastOneOnOneDate: "2026-07-01", lastOneOnOneOpenItems: 1, lastFeedbackAt: 1780000000000,
        },
      ]),
    );
    renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

    expect(await screen.findByText("Last 1:1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(screen.getByLabelText("Reports", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "All reports (including indirect)" }));
    await waitFor(() => {
      expect(screen.queryByText("Last 1:1")).toBeNull();
    });
  });

  test("a disabled FEEDBACKS feature drops the feedback menu and stat row; 1:1 and Goals stay (v1.53.0)", async () => {
    localStorage.setItem("lettuce.auth.disabledFeatures", JSON.stringify(["FEEDBACKS"]));
    try {
      setupMocks(
        mockFetch,
        membersPage([
          {
            userId: 11, name: "Bob Brown", email: "bob@x.test", teamId: 4, teamName: "Support",
            lastOneOnOneDate: "2026-07-01", lastOneOnOneOpenItems: 1, lastFeedbackAt: 1780000000000,
          },
        ]),
      );
      renderWithProviders(<TeamMembersTable view="managed" emptyMessage="No team members" />);

      // The 1:1 dropdown and Goals link survive…
      expect(
        await screen.findByRole("button", { name: "1:1 actions for Bob Brown" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Goals for Bob Brown" })).toBeInTheDocument();
      // …while every feedback affordance is gone: no trigger, no provide/ask items anywhere.
      expect(screen.queryByRole("button", { name: /feedback actions for/i })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: /provide feedback/i })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: /ask .* for feedback/i })).toBeNull();
      // The stat rows follow the same gate: "Last feedback" is gone, "Last 1:1" stays.
      expect(screen.getByText("Last 1:1")).toBeInTheDocument();
      expect(screen.queryByText("Last feedback")).toBeNull();
    } finally {
      localStorage.removeItem("lettuce.auth.disabledFeatures");
    }
  });

  test("cards keep the API's ordering (first appearance wins for deduped people)", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable view="member" emptyMessage="No teammates" />);

    await screen.findByText("Bob Brown");
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("Alice Adams")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Bob Brown")).toBeInTheDocument();
  });
});

// The team-scoped embedding (the team-details page's manager view): the grid pins to one managed team.
describe("TeamMembersTable pinned to a team", () => {
  let mockFetch: FetchMock;

  const PINNED_PROPS = {
    view: "managed",
    teamId: 5,
    settingsKey: "teamSubordinates",
    backTo: "/teams/5/details",
    emptyMessage: "No team members",
  } as const;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLE_KEY, "[]");
    localStorage.setItem(USER_ID_KEY, "7");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("queries with the pinned teamId, never includeIndirect, and skips the teams lookup", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable {...PINNED_PROPS} />);

    await screen.findByText("Bob Brown");
    const urls = memberUrls(mockFetch);
    expect(urls[0]).toContain("view=managed");
    expect(urls[0]).toContain("teamId=5");
    expect(urls.every((u) => !u.includes("includeIndirect"))).toBe(true);
    // The team Select never mounts, so the all-teams lookup never fires.
    const teamListCalls = mockFetch.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/v1/teams?"));
    expect(teamListCalls).toHaveLength(0);
  });

  test("hides the team and reports-scope filters; name and email stay", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable {...PINNED_PROPS} />);
    await screen.findByText("Bob Brown");

    await user.click(screen.getByRole("button", { name: /filters/i }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("Team", { selector: "input" })).toBeNull();
    expect(screen.queryByLabelText("Reports", { selector: "input" })).toBeNull();
  });

  test("cards keep the direct-report affordances: stats, New 1:1, 1:1s, Goals", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable {...PINNED_PROPS} />);
    await screen.findByText("Bob Brown");

    // The stats block renders (direct scope is forced by the pin).
    expect(screen.getAllByText("Last 1:1").length).toBeGreaterThan(0);
    await openCardMenu(/1:1 actions for bob brown/i);
    expect(await screen.findByRole("menuitem", { name: /new 1:1 with bob brown/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /1:1 meetings with bob brown/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /goals for bob brown/i })).toBeInTheDocument();
  });

  test("action links return to the team view; drill-downs carry the team origin", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<TeamMembersTable {...PINNED_PROPS} />);
    await screen.findByText("Bob Brown");

    const back = encodeURIComponent("/teams/5/details");
    await openCardMenu(/feedback actions for bob brown/i);
    expect(
      await screen.findByRole("menuitem", { name: /provide feedback to bob brown/i }),
    ).toHaveAttribute("href", `/feedback/new?subjectId=11&back=${back}`);
    // Drill-downs carry the team origin AND the exact host URL as the v1.39.0 back=
    // override (v2.5.5 — the embedding may hold an origin query the round-trip preserves).
    expect(screen.getByRole("menuitem", { name: /feedbacks with bob brown/i })).toHaveAttribute(
      "href",
      `/users/11/feedbacks?name=Bob+Brown&from=team&teamId=5&back=${back}`,
    );
    await openCardMenu(/1:1 actions for bob brown/i);
    expect(
      await screen.findByRole("menuitem", { name: /new 1:1 with bob brown/i }),
    ).toHaveAttribute(
      "href",
      `/one-on-ones/new?subordinateId=11&back=${back}`,
    );
    expect(screen.getByRole("menuitem", { name: /1:1 meetings with bob brown/i })).toHaveAttribute(
      "href",
      `/users/11/one-on-ones?name=Bob%20Brown&from=team&teamId=5&back=${back}`,
    );
    expect(screen.getByRole("link", { name: /goals for bob brown/i })).toHaveAttribute(
      "href",
      `/users/11/goals?name=Bob%20Brown&from=team&teamId=5&back=${back}`,
    );
  });

  test("filter state persists under the embedded settings namespace", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<TeamMembersTable {...PINNED_PROPS} />);
    await screen.findByText("Bob Brown");

    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.type(screen.getByLabelText("Name"), "bo");
    await waitFor(() => {
      expect(
        localStorage.getItem("lettuce.viewSettings.teamSubordinates.filter.name"),
      ).toContain("bo");
    });
    expect(localStorage.getItem("lettuce.viewSettings.teamMembers.managed.filter.name")).toBeNull();
  });
});
