import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CreatePerformanceReview from "./CreatePerformanceReview";
import { jsonResponse } from "../test/http";

const TOKEN_KEY = "lettuce.auth.token";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{`${location.pathname}${location.search}`}</div>;
}

const PERIODS = [
  { id: 4, startMonth: "2025-07", endMonth: "2025-12" },
  { id: 5, startMonth: "2026-01", endMonth: "2026-06" },
];

function renderPage(path = "/performance-reviews/new") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/performance-reviews/new" element={<CreatePerformanceReview />} />
            <Route path="*" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("CreatePerformanceReview page", () => {
  let mockFetch: FetchMock;

  function setupMocks(createResponse: () => Promise<Response>, periods: unknown[] = PERIODS) {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/v1/review-periods")) {
        return Promise.resolve(jsonResponse(200, { items: periods }));
      }
      if (u.includes("/api/v1/performance-reviews") && method === "POST") {
        return createResponse();
      }
      if (u.includes("/api/v1/teams/members")) {
        return Promise.resolve(
          jsonResponse(200, {
            items: [{ userId: 8, name: "Sub Ordinate", email: "s@x", teamId: 1, teamName: "AAA" }],
            page: 1,
            pageSize: 100,
            total: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { items: [], page: 1, pageSize: 20, total: 0 }));
    });
  }

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

  test("prefilled subordinate: creates against the latest period and lands in the editor", async () => {
    setupMocks(() =>
      Promise.resolve(jsonResponse(201, { id: 42, managerId: 7, subordinateId: 8 })),
    );
    renderPage(
      "/performance-reviews/new?subordinateId=8&subordinateName=Sub+Ordinate&back=%2Fperformance%3Ftab%3Dmanaged",
    );

    // The picker is skipped — the person renders as a fixed field; the period defaults to
    // the LATEST (the newest-first head).
    expect(await screen.findByText("Sub Ordinate")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Pick a team member")).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText("Period", { selector: "input" })).toHaveValue("January 2026 – June 2026"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe(
        "/performance-reviews/42/edit?back=%2Fperformance%3Ftab%3Dmanaged",
      ),
    );
    const createCall = mockFetch.mock.calls.find((c) => c[1]?.method === "POST");
    expect(JSON.parse(String(createCall![1]!.body))).toEqual({ subordinateId: 8, periodId: 5 });
  });

  test("an occupied slot (409) surfaces the duplicate message with a link to the existing review", async () => {
    setupMocks(() =>
      Promise.resolve(
        jsonResponse(409, {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "already exists",
          instance: "/api/v1/performance-reviews/33",
        }),
      ),
    );
    renderPage("/performance-reviews/new?subordinateId=8&subordinateName=Sub+Ordinate");

    await waitFor(() =>
      expect(screen.getByLabelText("Period", { selector: "input" })).toHaveValue("January 2026 – June 2026"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("This team member already has a review for this period."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the existing review" })).toHaveAttribute(
      "href",
      expect.stringContaining("/performance-reviews/33/view"),
    );
  });

  test("a not-yet-started period is disabled and the default skips to the newest started one", async () => {
    // Fake only Date (the TeamMembersTable idiom): "today" sits inside period 5, so period 6
    // hasn't started and must be unpickable (the server would 400 it).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T12:00:00"));
    try {
      setupMocks(
        () => Promise.resolve(jsonResponse(201, { id: 44 })),
        [...PERIODS, { id: 6, startMonth: "2026-07", endMonth: "2026-12" }],
      );
      renderPage("/performance-reviews/new?subordinateId=8&subordinateName=Sub+Ordinate");

      // The newest option (July–December) is future — the default falls to period 5.
      await waitFor(() =>
        expect(screen.getByLabelText("Period", { selector: "input" })).toHaveValue(
          "January 2026 – June 2026",
        ),
      );
      fireEvent.click(screen.getByLabelText("Period", { selector: "input" }));
      const futureOption = await screen.findByRole("option", { name: /July 2026 – December 2026/ });
      expect(futureOption).toHaveAttribute("data-combobox-disabled");
      expect(screen.queryByText(/still in the future/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("with every period still in the future there is no valid choice: alert + Create disabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-01-10T12:00:00")); // before both fixture periods start
    try {
      setupMocks(() => Promise.resolve(jsonResponse(201, { id: 45 })));
      renderPage("/performance-reviews/new?subordinateId=8&subordinateName=Sub+Ordinate");

      expect(
        await screen.findByText(
          "All review periods are still in the future — a review can be created once its period starts.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Period", { selector: "input" })).toHaveValue("");
      expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("without a prefill the direct-report picker gates the Create button", async () => {
    setupMocks(() => Promise.resolve(jsonResponse(201, { id: 43 })));
    renderPage();

    expect(await screen.findByText("New review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Team member", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: /Sub Ordinate/ }));
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });
});
