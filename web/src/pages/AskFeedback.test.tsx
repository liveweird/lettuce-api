import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AskFeedback from "./AskFeedback";
import { jsonResponse } from "../test/http";
import { addIsoDays, todayIsoDate } from "../utils/datetime";

// The page resolves the provider's display name from the org pool (v2.35.0) — the URL's
// providerName is ignored. Mocked at the hook level: this screen has no picker, so the pool's
// only job here is the id → name resolution (and the unknown-id bounce, tested below).
vi.mock("../hooks/useAllUsers", () => ({
  useAllUsers: () => ({
    userPool: [
      { id: 3, name: "Me Myself" },
      { id: 10, name: "Manny Manager" },
    ],
    usersLoading: false,
    usersError: false,
    usersReady: true,
  }),
}));

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;


function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{`${location.pathname}${location.search}`}</div>;
}

function renderAskFeedback(query = "?providerId=10&providerName=Manny%20Manager") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/feedback/ask${query}`]}>
          <Routes>
            <Route path="/feedback/ask" element={<AskFeedback />} />
            <Route path="/" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("AskFeedback page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLE_KEY, "[]");
    localStorage.setItem(USER_ID_KEY, "3"); // me
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("redirects to the managers tab when providerId is missing", () => {
    renderAskFeedback("");
    expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=managers");
    expect(screen.queryByRole("heading", { name: /ask for feedback/i })).toBeNull();
  });

  test("bounces back when the provider id matches no user (v2.35.0)", () => {
    mockFetch.mockResolvedValue(jsonResponse(404, {}));
    renderAskFeedback("?providerId=999&providerName=Impostor");
    expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=managers");
    expect(screen.queryByText("Impostor")).toBeNull();
  });

  test("warns early and disables the request when this ask is already pending", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).startsWith("/api/v1/feedbacks/duplicate-check")) {
        return Promise.resolve(jsonResponse(200, { existingId: 33, existingStatus: "REQUESTED" }));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    renderAskFeedback();

    expect(
      await screen.findByText(
        "This feedback has already been requested and is waiting for the provider.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the existing feedback" })).toHaveAttribute(
      "href",
      "/feedback/33/view",
    );
    expect(screen.getByRole("button", { name: /send request/i })).toBeDisabled();

    // The check fires with the ask triple: subject == requester == me (3), provider from the URL.
    const checkUrl = mockFetch.mock.calls
      .map(([u]) => String(u))
      .find((u) => u.includes("duplicate-check"));
    expect(checkUrl).toContain("subjectId=3");
    expect(checkUrl).toContain("providerId=10");
    expect(checkUrl).toContain("requesterId=3");
  });

  test("shows the provider and offers the requester-inclusive visibilities", async () => {
    renderAskFeedback();

    expect(screen.getByRole("heading", { name: /ask for feedback/i })).toBeInTheDocument();
    // The parties render as labeled persona displays (avatar chip / plain "You"), not inputs.
    expect(screen.getByText("Manny Manager")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    // Visibility is the only editable field — there is no content box.
    expect(screen.queryByLabelText("Content")).toBeNull();

    fireEvent.click(screen.getByLabelText("Visibility", { selector: "input" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Provider + requester",
      "Provider + requester + subject",
      "Public",
    ]);
  });

  test("submits a REQUESTED feedback with self as subject+requester and returns to managers", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/v1/feedbacks" ? jsonResponse(201, { id: 99 }) : jsonResponse(404, {})),
    );
    const user = userEvent.setup();
    renderAskFeedback();

    await user.click(screen.getByRole("button", { name: /send request/i }));

    const postCall = mockFetch.mock.calls.find(
      ([url, init]) => url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      requesterId: 3,
      subjectId: 3,
      providerId: 10,
      visibility: "PROVIDER_REQUESTER_SUBJECT",
      status: "REQUESTED",
      content: "",
    });

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=managers"));
  });

  test("a chosen expiration preset resolves to a computed expiresOn in the payload", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/v1/feedbacks" ? jsonResponse(201, { id: 99 }) : jsonResponse(404, {})),
    );
    const user = userEvent.setup();
    renderAskFeedback();

    await user.click(screen.getByRole("combobox", { name: "Expiration" }));
    await user.click(await screen.findByRole("option", { name: "In 2 weeks", hidden: true }));
    await user.click(screen.getByRole("button", { name: /send request/i }));

    const postCall = mockFetch.mock.calls.find(
      ([url, init]) => url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string).expiresOn).toBe(
      addIsoDays(todayIsoDate(), 14),
    );
  });

  test("includes the trimmed requester message in the payload when filled", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/v1/feedbacks" ? jsonResponse(201, { id: 99 }) : jsonResponse(404, {})),
    );
    const user = userEvent.setup();
    renderAskFeedback();

    await user.type(
      screen.getByLabelText("Message to the provider"),
      "  Please focus on my leadership skills  ",
    );
    await user.click(screen.getByRole("button", { name: /send request/i }));

    const postCall = mockFetch.mock.calls.find(
      ([url, init]) => url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      requesterId: 3,
      subjectId: 3,
      providerId: 10,
      visibility: "PROVIDER_REQUESTER_SUBJECT",
      status: "REQUESTED",
      content: "",
      requesterMessage: "Please focus on my leadership skills",
    });
  });

  test("honors an explicit back param on submit and discard", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/v1/feedbacks" ? jsonResponse(201, { id: 99 }) : jsonResponse(404, {})),
    );
    const user = userEvent.setup();
    // back = "/?tab=peers", url-encoded
    renderAskFeedback(
      `?providerId=10&providerName=Manny%20Manager&back=${encodeURIComponent("/?tab=peers")}`,
    );

    // Discard link points back at the originating tab, not the managers default (the guard
    // asks only once there is work to lose — v3.5.0).
    await user.type(screen.getByLabelText("Message to the provider"), "some context");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: /discard/i })).toHaveAttribute(
      "href",
      "/?tab=peers",
    );
    await user.click(within(dialog).getByRole("button", { name: /keep editing/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Submitting also returns to the originating tab.
    await user.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=peers"));
  });

  test("shows a permission error when the request is forbidden", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/v1/feedbacks" ? jsonResponse(403, {}) : jsonResponse(404, {})),
    );
    const user = userEvent.setup();
    renderAskFeedback();

    await user.click(screen.getByRole("button", { name: /send request/i }));
    expect(await screen.findByText(/don't have permission to request/i)).toBeInTheDocument();
    // Stays on the page rather than navigating away.
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  test("maps 400 to a validation message and other statuses to a generic one", async () => {
    const user = userEvent.setup();

    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/v1/feedbacks" ? jsonResponse(400, {}) : jsonResponse(404, {})),
    );
    const first = renderAskFeedback();
    await user.click(screen.getByRole("button", { name: /send request/i }));
    expect(await screen.findByText(/validation error/i)).toBeInTheDocument();
    first.unmount();

    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/v1/feedbacks" ? jsonResponse(500, {}) : jsonResponse(404, {})),
    );
    renderAskFeedback();
    await user.click(screen.getByRole("button", { name: /send request/i }));
    expect(await screen.findByText(/request failed \(500\)/i)).toBeInTheDocument();
  });
});
