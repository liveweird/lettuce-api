import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CreateSuccessionPlan from "./CreateSuccessionPlan";
import { theme } from "../theme";
import { jsonResponse } from "../test/http";

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{`${location.pathname}${location.search}`}</div>;
}

const REPORTS = {
  items: [
    { userId: 8, name: "Sam Seat", email: "sam@example.com", teamId: 1, teamName: "alpha" },
    { userId: 11, name: "Bob Brown", email: "bob@example.com", teamId: 1, teamName: "alpha" },
  ],
  page: 1,
  pageSize: 100,
  total: 2,
};

const CREATED = {
  id: 42,
  managerId: 7,
  managerName: "Me",
  userId: 8,
  userName: "Sam Seat",
  roleCriticality: "CRITICAL",
  retentionRisk: "HIGH",
  lossImpact: ["Client trust"],
  targetBenchDepth: 2,
  status: "OPEN",
  benchCount: 0,
  nominations: [],
  createdAt: 1,
  lastReviewedAt: 1,
};

function renderScreen({ createStatus = 201 } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mockFetch = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/v1/succession-plans" && init?.method === "POST") {
      return Promise.resolve(
        createStatus === 201
          ? jsonResponse(201, CREATED)
          : jsonResponse(createStatus, { title: "Conflict", status: createStatus }),
      );
    }
    if (u.includes("/api/v1/teams/members")) {
      return Promise.resolve(jsonResponse(200, REPORTS));
    }
    return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 20, total: 0 }));
  });
  vi.stubGlobal("fetch", mockFetch);
  render(
    <MantineProvider env="test" theme={theme}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/succession/new"]}>
          <Routes>
            <Route path="/succession/new" element={<CreateSuccessionPlan />} />
            <Route path="*" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return mockFetch;
}

describe("CreateSuccessionPlan page", () => {
  beforeEach(() => {
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLE_KEY, "[]");
    localStorage.setItem(USER_ID_KEY, "7");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("picking a report and submitting POSTs the full definition, then lands on the plan view", async () => {
    const user = userEvent.setup();
    const mockFetch = renderScreen();

    expect(await screen.findByRole("heading", { name: "New succession plan" })).toBeInTheDocument();
    // Create stays disabled until a person is picked.
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    await user.click(screen.getByLabelText("Person", { selector: "input" }));
    await user.click(await screen.findByRole("option", { name: /Sam Seat/ }));

    // The sliders (v2.44.0): defaults CORE/MEDIUM sit mid-scale; one ArrowRight promotes
    // each to the severe end (the CareerPyramid keyboard-driving idiom).
    fireEvent.keyDown(screen.getByRole("slider", { name: "Role criticality" }), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Retention risk" }), {
      key: "ArrowRight",
    });

    await user.click(screen.getByRole("button", { name: "Add impact item" }));
    await user.type(screen.getByLabelText("Loss-impact item 1"), "Client trust");

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/v1/succession-plans" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        userId: 8,
        roleCriticality: "CRITICAL",
        retentionRisk: "HIGH",
        lossImpact: ["Client trust"],
        targetBenchDepth: 2,
      });
    });
    // Nominating successors is the natural next step — land on the fresh plan.
    expect(await screen.findByTestId("probe")).toHaveTextContent("/succession/42/view");
  });

  test("a 409 (duplicate open plan) renders the conflict wording inline", async () => {
    const user = userEvent.setup();
    renderScreen({ createStatus: 409 });

    await user.click(await screen.findByLabelText("Person", { selector: "input" }));
    await user.click(await screen.findByRole("option", { name: /Sam Seat/ }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(/an open plan for this person may already exist/i),
    ).toBeInTheDocument();
  });
});
