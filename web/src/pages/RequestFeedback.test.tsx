import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RequestFeedback from "./RequestFeedback";
import { jsonResponse } from "../test/http";
import { addIsoDays, todayIsoDate } from "../utils/datetime";

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;


function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{`${location.pathname}${location.search}`}</div>;
}

// Requester is user 3; subject is user 7 (Mona). Providers are users 10/11.
const USER_POOL = [
  { id: 3, name: "Me Myself", email: "me@example.com", roles: [] as const },
  { id: 7, name: "Mona Subject", email: "mona@example.com", roles: [] as const },
  { id: 10, name: "Alice Provider", email: "alice@example.com", roles: [] as const },
  { id: 11, name: "Bob Provider", email: "bob@example.com", roles: [] as const },
];

function setupMocks(mockFetch: FetchMock, onFeedbacks: (init?: RequestInit) => Response) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/v1/users?")) {
      return Promise.resolve(
        jsonResponse(200, { items: USER_POOL, page: 1, pageSize: 100, total: USER_POOL.length }),
      );
    }
    if (url === "/api/v1/feedbacks") return Promise.resolve(onFeedbacks(init));
    return Promise.resolve(jsonResponse(404, {}));
  });
}

function renderRequestFeedback(query = "?subjectId=7&subjectName=Mona") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/feedback/request${query}`]}>
          <Routes>
            <Route path="/feedback/request" element={<RequestFeedback />} />
            <Route path="/" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

// The provider picker is a searchable Select whose options come from an async user
// fetch. Typing keeps the dropdown open and findByRole retries, so this resolves the
// race against the pool load without depending on any other on-page data marker.
async function addProvider(user: ReturnType<typeof userEvent.setup>, label: string) {
  const input = screen.getByPlaceholderText("Pick a user");
  await user.click(input);
  await user.type(input, label.split(" ")[0]);
  await user.click(await screen.findByRole("option", { name: label, hidden: true }));
  await user.click(screen.getByRole("button", { name: /^add$/i }));
}

describe("RequestFeedback page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLE_KEY, "[]");
    localStorage.setItem(USER_ID_KEY, "3");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("redirects to the subordinates tab when subjectId is missing", () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 1 }));
    renderRequestFeedback("");
    expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=subordinates");
  });

  test("shows the subject and a provider picker that excludes the requester and the subject", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 1 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    // The parties render as labeled persona displays (avatar chip / plain "You"), not inputs.
    expect((await screen.findAllByText("Mona Subject")).length).toBeGreaterThan(0);
    expect(screen.getByText("You")).toBeInTheDocument();

    const picker = screen.getByPlaceholderText("Pick a user");
    await user.click(picker);
    // Typing the shared "Provider" substring keeps the dropdown open and lets the
    // async user pool resolve; only the two providers match.
    await user.type(picker, "Provider");
    expect(await screen.findByRole("option", { name: "Alice Provider", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Bob Provider", hidden: true })).toBeInTheDocument();

    // The requester (Me, id 3) AND the subject (Mona, id 7) are filtered out — requesting a
    // self-reflection went away with the feature (v2.36.0).
    await user.clear(picker);
    await user.type(picker, "M");
    expect(screen.queryByRole("option", { name: "Mona Subject", hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Me Myself", hidden: true })).not.toBeInTheDocument();
  });

  test("a selected provider with an existing request is flagged and blocks submitting", async () => {
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith("/api/v1/users?")) {
        return Promise.resolve(
          jsonResponse(200, { items: USER_POOL, page: 1, pageSize: 100, total: USER_POOL.length }),
        );
      }
      if (u.startsWith("/api/v1/feedbacks/duplicate-check")) {
        const providerId = new URL(u, "http://localhost").searchParams.get("providerId");
        return Promise.resolve(
          providerId === "10"
            ? jsonResponse(200, { existingId: 77, existingStatus: "REQUESTED" })
            : jsonResponse(200, { existingId: null, existingStatus: null }),
        );
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    const user = userEvent.setup();
    renderRequestFeedback();
    await screen.findAllByText("Mona Subject");

    // Alice (10) already has this request in progress: her row is flagged with a view link
    // and Request is blocked.
    await addProvider(user, "Alice Provider");
    expect(
      await screen.findByText(
        "This feedback has already been requested and is waiting for the provider.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the existing feedback" })).toHaveAttribute(
      "href",
      "/feedback/77/view",
    );
    expect(screen.getByRole("button", { name: /^request$/i })).toBeDisabled();

    // A clean provider (Bob, 11) doesn't unblock while Alice stays selected…
    await addProvider(user, "Bob Provider");
    expect(screen.getByRole("button", { name: /^request$/i })).toBeDisabled();

    // …removing the flagged provider re-enables Request.
    await user.click(screen.getByRole("button", { name: /remove alice provider/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^request$/i })).toBeEnabled(),
    );
  });

  test("adding a provider lists them; removing clears back to the empty state", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 1 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await addProvider(user, "Alice Provider");
    // Scope to the table and query by text — the picker's option node also carries the name,
    // and the PersonaChip avatar initials join the cell's accessible name.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Alice Provider")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /remove alice provider/i }));
    expect(within(table).queryByText("Alice Provider")).not.toBeInTheDocument();
    expect(screen.getByText(/add at least one provider/i)).toBeInTheDocument();
  });

  test("Request is disabled until at least one provider is selected", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 1 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    expect(screen.getByRole("button", { name: /^request$/i })).toBeDisabled();

    await addProvider(user, "Alice Provider");
    expect(screen.getByRole("button", { name: /^request$/i })).not.toBeDisabled();
  });

  test("submitting creates a REQUESTED feedback per provider and navigates to subordinates", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 99 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await addProvider(user, "Alice Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=subordinates"),
    );
    const postCall = mockFetch.mock.calls.find(
      ([url, init]) => url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      requesterId: 3,
      subjectId: 7,
      providerId: 10,
      visibility: "PROVIDER_REQUESTER_SUBJECT",
      status: "REQUESTED",
      content: "",
    });
  });

  test("the shared requester message is sent to every selected provider", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 99 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await user.type(screen.getByLabelText("Message to the provider"), "  Prep for the review  ");
    await addProvider(user, "Alice Provider");
    await addProvider(user, "Bob Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    const postCalls = mockFetch.mock.calls.filter(
      ([url, init]) => url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(2);
    for (const call of postCalls) {
      expect(JSON.parse((call[1] as RequestInit).body as string).requesterMessage).toBe(
        "Prep for the review",
      );
    }
  });

  test("a chosen visibility is reflected in the submitted request", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 99 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    // "Public" is unique to the visibility Select, so target the option directly rather
    // than a listbox (two Selects on this page each render a listbox).
    await user.click(screen.getByPlaceholderText("Select visibility"));
    await user.click(await screen.findByRole("option", { name: "Public", hidden: true }));

    await addProvider(user, "Alice Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        ([url, init]) =>
          url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse((postCall![1] as RequestInit).body as string).visibility).toBe("PUBLIC");
    });
  });

  test("403 shows a permission error alert", async () => {
    setupMocks(mockFetch, () => jsonResponse(403, { error: "forbidden", message: "no" }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await addProvider(user, "Alice Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    expect(await screen.findByText(/don't have permission to request this feedback/i)).toBeInTheDocument();
  });

  test("400 shows a validation error alert", async () => {
    setupMocks(mockFetch, () => jsonResponse(400, { error: "bad_request", message: "no" }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await addProvider(user, "Alice Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    expect(await screen.findByText(/validation error/i)).toBeInTheDocument();
  });

  test("a network error shows a connection alert", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/users?")) {
        return Promise.resolve(
          jsonResponse(200, { items: USER_POOL, page: 1, pageSize: 100, total: USER_POOL.length }),
        );
      }
      if (url === "/api/v1/feedbacks" && init?.method === "POST") {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await addProvider(user, "Alice Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    expect(await screen.findByText(/check your connection/i)).toBeInTheDocument();
  });

  test("Cancel opens a discard modal whose Discard link points at subordinates", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 1 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    // The guard asks only once there is work to lose (v3.5.0).
    await user.type(screen.getByLabelText("Message to the provider"), "some context");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/discard this feedback request/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /discard/i })).toHaveAttribute(
      "href",
      "/?tab=subordinates",
    );

    await user.click(within(dialog).getByRole("button", { name: /keep editing/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("honors an explicit back param on submit and discard", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 99 }));
    const user = userEvent.setup();
    // back = "/?tab=peers", url-encoded
    renderRequestFeedback(
      `?subjectId=7&subjectName=Mona&back=${encodeURIComponent("/?tab=peers")}`,
    );

    await screen.findAllByText("Mona Subject");

    // Discard link points back at the originating tab, not the subordinates default.
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
    await addProvider(user, "Alice Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/?tab=peers"));
  });

  test("a chosen expiration preset resolves to a computed expiresOn on every provider's payload", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 99 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await user.click(screen.getByRole("combobox", { name: "Expiration" }));
    await user.click(await screen.findByRole("option", { name: "In 1 week", hidden: true }));

    await addProvider(user, "Alice Provider");
    await addProvider(user, "Bob Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    const expected = addIsoDays(todayIsoDate(), 7);
    const postCalls = mockFetch.mock.calls.filter(
      ([url, init]) => url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(2);
    for (const call of postCalls) {
      expect(JSON.parse((call[1] as RequestInit).body as string).expiresOn).toBe(expected);
    }
  });

  test("the custom date pick sends the chosen ISO date as expiresOn", async () => {
    setupMocks(mockFetch, () => jsonResponse(201, { id: 99 }));
    const user = userEvent.setup();
    renderRequestFeedback();

    await screen.findAllByText("Mona Subject");
    await user.click(screen.getByRole("combobox", { name: "Expiration" }));
    await user.click(await screen.findByRole("option", { name: "Pick a date…", hidden: true }));

    fireEvent.change(screen.getByLabelText("Expiration date"), { target: { value: "2099-06-15" } });

    await addProvider(user, "Alice Provider");
    await user.click(screen.getByRole("button", { name: /^request$/i }));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        ([url, init]) =>
          url === "/api/v1/feedbacks" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse((postCall![1] as RequestInit).body as string).expiresOn).toBe("2099-06-15");
    });
  });

  test("a mid-batch failure keeps only the failed provider listed, with its reason", async () => {
    const user = userEvent.setup();
    // Alice's (id 10) create lands; Bob's (id 11) 500s.
    setupMocks(mockFetch, (init) => {
      const body = JSON.parse(String(init?.body)) as { providerId: number };
      return body.providerId === 11 ? jsonResponse(500, { status: 500 }) : jsonResponse(201, { id: 99 });
    });
    renderRequestFeedback();
    await addProvider(user, "Alice Provider");
    await addProvider(user, "Bob Provider");
    await user.click(screen.getByRole("button", { name: "Request" }));

    // The partial outcome is itemized; the succeeded request is NOT retried on resubmit.
    expect(
      await screen.findByText("1 of 2 requests were sent. These providers failed and stayed in the list:"),
    ).toBeInTheDocument();
    expect(screen.getByText("Bob Provider — Request failed (500)")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Alice Provider")).toBeNull();
    expect(within(table).getByText("Bob Provider")).toBeInTheDocument();
    // Still on the page — no navigation happened.
    expect(screen.queryByTestId("probe")).toBeNull();
  });
});
