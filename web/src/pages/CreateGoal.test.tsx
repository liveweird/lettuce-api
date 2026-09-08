import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CreateGoal from "./CreateGoal";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

vi.mock("../components/MarkdownEditor", async () =>
  (await import("../test/mockMarkdownEditor")).mockMarkdownEditorModule(),
);

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{`${location.pathname}${location.search}`}</div>;
}

// One person on two teams — the picker must dedupe to a single option.
const REPORTS = {
  items: [
    { userId: 8, name: "Sam Subordinate", email: "sam@example.com", teamId: 1, teamName: "alpha" },
    { userId: 8, name: "Sam Subordinate", email: "sam@example.com", teamId: 2, teamName: "beta" },
    { userId: 11, name: "Bob Brown", email: "bob@example.com", teamId: 1, teamName: "alpha" },
  ],
  page: 1,
  pageSize: 100,
  total: 3,
};

const CREATED = {
  id: 42,
  managerId: 7,
  managerName: "Me",
  subordinateId: 8,
  subordinateName: "Sam Subordinate",
  createdAt: Date.now(),
  dueDate: "2099-06-15",
  title: "Ship it",
  description: "",
  type: "NUMBER",
  targetValue: 4,
  currentValue: 0,
  milestones: [],
  status: "DRAFT",
  summary: null,
  lastModified: Date.now(),
};

function renderScreen(route = "/goals/new") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/goals/new" element={<CreateGoal />} />
            <Route path="*" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("CreateGoal page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? "GET") === "POST" && u === "/api/v1/goals") {
        return Promise.resolve(jsonResponse(201, CREATED));
      }
      if ((init?.method ?? "GET") === "POST" && u === "/api/v1/goals/42/activate") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (u.includes("/api/v1/teams/members")) {
        return Promise.resolve(jsonResponse(200, REPORTS));
      }
      return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 20, total: 0 }));
    });
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLE_KEY, "[]");
    localStorage.setItem(USER_ID_KEY, "7");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function fillDefinition(user: ReturnType<typeof userEvent.setup>, title = "Ship it") {
    await user.type(await screen.findByLabelText(/title/i), title);
    const target = screen.getByLabelText(/target/i);
    await user.clear(target);
    await user.type(target, "4");
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-06-15" } });
  }

  test("picks a deduped report, creates, answers No, and returns to the origin", async () => {
    const user = userEvent.setup();
    renderScreen();

    // Create stays disabled until a team member is picked.
    await fillDefinition(user);
    expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Team member", { selector: "input" }));
    // The team names ride a dimmed subtitle, not the option's plain-name label — matched via
    // a pattern since the option's full accessible name now includes that subtitle too.
    const options = await screen.findAllByRole("option", { name: /Sam Subordinate/ });
    expect(options).toHaveLength(1); // two team rows, one person
    fireEvent.click(options[0]);

    await user.click(screen.getByRole("button", { name: /^create$/i }));

    // The goal is created first; the activate prompt then appears.
    expect(
      await screen.findByText("Do you want to activate the goal immediately?"),
    ).toBeInTheDocument();
    const post = mockFetch.mock.calls.find(
      ([u, init]) => String(u) === "/api/v1/goals" && (init as RequestInit)?.method === "POST",
    );
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      subordinateId: 8,
      title: "Ship it",
      description: "",
      type: "NUMBER",
      targetValue: 4,
      targetDirection: "AT_LEAST",
      milestones: [],
      dueDate: "2099-06-15",
    });

    // No → the draft is kept (no activate call) and we return to the default origin.
    await user.click(screen.getByRole("button", { name: /^no$/i }));
    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=subordinates");
    });
    expect(
      mockFetch.mock.calls.some(([u]) => String(u).includes("/activate")),
    ).toBe(false);
  });

  test("the report picker shows team subtitles and searching a team name filters it", async () => {
    const user = userEvent.setup();
    // The theme (not just env="test") must be wired for the folded-keywords filter to be
    // active (web/CLAUDE.md) — the shared renderWithProviders helper does that.
    renderWithProviders(<CreateGoal />, { route: "/goals/new" });

    await fillDefinition(user);
    await user.click(screen.getByLabelText("Team member", { selector: "input" }));

    // Sam's two teams ride one dimmed subtitle; Bob's single team its own.
    expect(await screen.findByText("alpha · beta")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();

    // Typing a team name filters the picker via the (hidden) team keywords, not just the label.
    await user.type(screen.getByLabelText("Team member", { selector: "input" }), "beta");
    expect(await screen.findByRole("option", { name: /Sam Subordinate/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Bob Brown/ })).not.toBeInTheDocument();

    // The closed-state value stays the plain name — no team text leaks into it.
    await user.click(screen.getByRole("option", { name: /Sam Subordinate/ }));
    expect(screen.getByLabelText("Team member", { selector: "input" })).toHaveValue(
      "Sam Subordinate",
    );
  });

  test("a prefilled subordinate skips the picker; Yes activates and returns to back", async () => {
    const user = userEvent.setup();
    // A crafted subordinateName rides along — it must be IGNORED: the identity resolves
    // from the caller's own managed pool (v2.35.0, the monkey-test SPA-1 fix).
    renderScreen(
      "/goals/new?subordinateId=8&subordinateName=Impostor&back=%2Fusers%2F8%2Fgoals%3Ffrom%3Dsubordinates",
    );

    expect(await screen.findByText("Sam Subordinate")).toBeInTheDocument();
    expect(screen.queryByText("Impostor")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Team member" })).toBeNull();

    await fillDefinition(user);
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    // Yes → the fresh draft is activated, then we return to the back target.
    await user.click(await screen.findByRole("button", { name: /^yes$/i }));
    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveTextContent("/users/8/goals?from=subordinates");
    });
    expect(
      mockFetch.mock.calls.some(
        ([u, init]) =>
          String(u) === "/api/v1/goals/42/activate" && (init as RequestInit)?.method === "POST",
      ),
    ).toBe(true);
  });

  test("dismissing the activate prompt keeps the draft and returns to back", async () => {
    const user = userEvent.setup();
    renderScreen("/goals/new?subordinateId=8&subordinateName=Sam&back=%2F%3Ftab%3Dsubordinates");

    await fillDefinition(user);
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await screen.findByText("Do you want to activate the goal immediately?");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=subordinates");
    });
    expect(
      mockFetch.mock.calls.some(([u]) => String(u).includes("/activate")),
    ).toBe(false);
  });

  test("a PLAN goal posts milestones with a null target and hides the target input", async () => {
    const user = userEvent.setup();
    renderScreen("/goals/new?subordinateId=8&subordinateName=Sam");

    await user.type(await screen.findByLabelText(/title/i), "Get certified");
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-06-15" } });
    fireEvent.click(screen.getByLabelText("Type", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Plan (milestones)" }));
    expect(screen.queryByLabelText(/target/i)).toBeNull();
    // The Direction select is PLAN-hidden like the target input (v2.41.0).
    expect(screen.queryByLabelText("Direction", { selector: "input" })).toBeNull();

    // The milestone editor appears; add two ordered steps.
    await user.click(screen.getByRole("button", { name: "Add milestone" }));
    await user.type(screen.getByLabelText("Milestone 1"), "Pass the exam");
    await user.click(screen.getByRole("button", { name: "Add milestone" }));
    await user.type(screen.getByLabelText("Milestone 2"), "File the certificate");

    await user.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([u, init]) => String(u) === "/api/v1/goals" && (init as RequestInit)?.method === "POST",
      );
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        type: "PLAN",
        targetValue: null,
        targetDirection: null,
        milestones: [{ description: "Pass the exam" }, { description: "File the certificate" }],
      });
    });
  });

  test("a blank milestone blocks a PLAN goal's creation", async () => {
    const user = userEvent.setup();
    renderScreen("/goals/new?subordinateId=8&subordinateName=Sam");

    await user.type(await screen.findByLabelText(/title/i), "Get certified");
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-06-15" } });
    fireEvent.click(screen.getByLabelText("Type", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Plan (milestones)" }));
    await user.click(screen.getByRole("button", { name: "Add milestone" }));

    await user.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByText("A milestone description is required")).toBeInTheDocument();
    expect(
      mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  test("validation blocks a blank title, a missing target, and a missing due date", async () => {
    const user = userEvent.setup();
    renderScreen("/goals/new?subordinateId=8&subordinateName=Sam");

    await screen.findByLabelText(/title/i);
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText("A title is required")).toBeInTheDocument();
    expect(
      screen.getByText("A target value is required for this goal type"),
    ).toBeInTheDocument();
    expect(screen.getByText("A due date is required")).toBeInTheDocument();
    expect(
      mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  test("validation blocks a past due date", async () => {
    const user = userEvent.setup();
    renderScreen("/goals/new?subordinateId=8&subordinateName=Sam");

    await fillDefinition(user);
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2020-01-01" } });
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText("The due date cannot be in the past")).toBeInTheDocument();
    expect(
      mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  test("Cancel opens the discard confirm; discarding returns to back", async () => {
    const user = userEvent.setup();
    renderScreen("/goals/new?subordinateId=8&back=%2F%3Ftab%3Dsubordinates");

    // The guard asks only once there is work to lose (v3.5.0).
    await user.type(await screen.findByLabelText(/title/i), "Half-written");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("link", { name: /^discard$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=subordinates"));
    expect(
      mockFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  test("a 403 shows the chain message and stays on the form", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(jsonResponse(403, { title: "no" }));
      }
      return Promise.resolve(jsonResponse(200, REPORTS));
    });
    const user = userEvent.setup();
    renderScreen("/goals/new?subordinateId=8&subordinateName=Sam");

    await fillDefinition(user);
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(
      await screen.findByText("You may only set goals for people in your management chain."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).toBeNull();
  });
});
