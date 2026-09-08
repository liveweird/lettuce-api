import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "../test/render";
import FeedbackTable from "./FeedbackTable";
import { jsonResponse } from "../test/http";

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

type FeedbackItem = {
  id: number;
  requesterId: number | null;
  requesterName: string | null;
  requesterDeleted: boolean;
  subjectId: number;
  subjectName: string;
  subjectDeleted: boolean;
  providerId: number;
  providerName: string;
  providerDeleted: boolean;
  visibility: "PROVIDER_SUBJECT" | "PROVIDER_REQUESTER" | "PROVIDER_REQUESTER_SUBJECT" | "PUBLIC";
  status: "REQUESTED" | "DRAFT" | "SENT" | "WITHDRAWN";
  contentPreview: string;
  subjects?: { id: number; name: string; deleted: boolean }[];
  expiresOn?: string | null;
};


function feedbacksPage(items: FeedbackItem[], total = items.length): Response {
  return jsonResponse(200, { items, page: 1, pageSize: 20, total });
}

const SEED_FEEDBACKS: FeedbackItem[] = [
  {
    id: 1,
    requesterId: 9,
    requesterName: "Carol Requester",
    requesterDeleted: false,
    subjectId: 7,
    subjectName: "Sam Subject",
    subjectDeleted: false,
    providerId: 10,
    providerName: "Alice Provider",
    providerDeleted: false,
    visibility: "PUBLIC",
    status: "SENT",
    contentPreview: "Great collaboration on the migration project",
  },
  {
    id: 2,
    requesterId: null,
    requesterName: null,
    requesterDeleted: false,
    subjectId: 8,
    subjectName: "Tina Subject",
    subjectDeleted: true,
    providerId: 11,
    providerName: "Bob Provider",
    providerDeleted: true,
    visibility: "PROVIDER_SUBJECT",
    status: "DRAFT",
    contentPreview: "Needs to improve estimates",
  },
];

function setupMocks(mockFetch: FetchMock, response: Response = feedbacksPage(SEED_FEEDBACKS)) {
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).startsWith("/api/v1/feedbacks") ? response.clone() : jsonResponse(404, {}),
    ),
  );
}

function feedbackUrls(mockFetch: FetchMock): string[] {
  return mockFetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/v1/feedbacks"));
}

describe("FeedbackTable (received view)", () => {
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

  test("renders rows with names, visibility and status", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    expect(await screen.findByText("Carol Requester")).toBeInTheDocument();
    expect(screen.getByText("Alice Provider")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();

    const urls = feedbackUrls(mockFetch);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain("view=received");
  });

  test("renders an em-dash for a missing requester and a (deleted) suffix", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    // The requester cell (and, since v3.5.0, an absent timestamp) render the dash.
    expect((await screen.findAllByText("—")).length).toBeGreaterThan(0);
    expect(screen.getByText("Bob Provider (deleted)")).toBeInTheDocument();
  });

  test("shows the expiration deadline under the status pill on a REQUESTED row only", async () => {
    setupMocks(
      mockFetch,
      feedbacksPage([
        { ...SEED_FEEDBACKS[0], status: "REQUESTED", expiresOn: "2099-06-15" },
        SEED_FEEDBACKS[1], // status: DRAFT, no expiresOn
      ]),
    );
    renderWithProviders(<FeedbackTable view="received" />);

    expect(await screen.findByText("Expires")).toBeInTheDocument();
    expect(screen.getByText("Jun 15, 2099")).toBeInTheDocument();
  });

  test("a REQUESTED row with no expiration shows no deadline text", async () => {
    setupMocks(mockFetch, feedbacksPage([{ ...SEED_FEEDBACKS[0], status: "REQUESTED" }]));
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Requested");
    expect(screen.queryByText("Expires")).toBeNull();
  });

  test("shows 'You' in the Requester column when the requester is the current user", async () => {
    // Caller is user 7; make them the requester of the first row.
    setupMocks(
      mockFetch,
      feedbacksPage([{ ...SEED_FEEDBACKS[0], requesterId: 7 }, SEED_FEEDBACKS[1]]),
    );
    renderWithProviders(<FeedbackTable view="received" />);

    expect(await screen.findByText("You")).toBeInTheDocument();
    expect(screen.queryByText("Carol Requester")).not.toBeInTheDocument();
    // The provider column (another user) is unaffected.
    expect(screen.getByText("Alice Provider")).toBeInTheDocument();
  });

  test("typing in the Requester filter triggers a refetch with requesterName=", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.type(screen.getByLabelText(/requester/i, { selector: "input" }), "caro");

    await waitFor(
      () => {
        expect(feedbackUrls(mockFetch).some((url) => url.includes("requesterName=caro"))).toBe(
          true,
        );
      },
      { timeout: 1500 },
    );
  });

  test("filters are collapsed by default and the toggle reveals them", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    const toggle = screen.getByRole("button", { name: /filters/i });
    // Collapsed by default — the toggle reports it and the space-eating filter row is hidden.
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText(/requester/i, { selector: "input" })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/requester/i, { selector: "input" })).toBeInTheDocument();

    // Toggling again collapses it.
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("the received view has no Reports scope filter", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    await user.click(screen.getByRole("button", { name: /filters/i }));
    expect(screen.getByLabelText(/requester/i, { selector: "input" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Reports", { selector: "input" })).not.toBeInTheDocument();
  });

  test("the Filters toggle shows a badge counting the active filters", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    const toggle = screen.getByRole("button", { name: /filters/i });
    // Nothing set, and the default "Last modified = All" must NOT count → no badge.
    expect(within(toggle).queryByText("1")).not.toBeInTheDocument();

    await user.click(toggle);
    await user.type(screen.getByLabelText(/requester/i, { selector: "input" }), "caro");
    expect(within(toggle).getByText("1")).toBeInTheDocument();
  });

  test("selecting Visibility and Status adds the corresponding params", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    fireEvent.click(screen.getByRole("button", { name: /filters/i }));

    // happy-dom does not open Mantine comboboxes via userEvent's pointer simulation
    fireEvent.click(screen.getByLabelText("Visibility", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Public" }));
    await waitFor(() => {
      expect(feedbackUrls(mockFetch).some((url) => url.includes("visibility=PUBLIC"))).toBe(true);
    });

    fireEvent.click(screen.getByLabelText("Status", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Draft" }));
    await waitFor(() => {
      expect(feedbackUrls(mockFetch).some((url) => url.includes("status=DRAFT"))).toBe(true);
    });
  });

  test("selecting a Last modified window adds the lastModified[gte] param; All omits it", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");

    // Default "All" sends no recency bound.
    expect(feedbackUrls(mockFetch).every((url) => !url.includes("lastModified"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByLabelText("Last modified", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "Last week" }));
    await waitFor(() => {
      // URLSearchParams percent-encodes the brackets.
      expect(feedbackUrls(mockFetch).some((url) => url.includes("lastModified%5Bgte%5D="))).toBe(
        true,
      );
    });
  });

  test("visibility filter offers all four values (own requests appear at any visibility)", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByLabelText("Visibility", { selector: "input" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Provider + subject",
      "Provider + requester",
      "Provider + requester + subject",
      "Public",
    ]);
  });

  test("clicking the Provider header toggles sort between asc and desc", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    expect(feedbackUrls(mockFetch)[0]).toContain("sort=providerName");

    await user.click(screen.getByRole("button", { name: /provider/i }));
    await waitFor(() => {
      expect(feedbackUrls(mockFetch).some((url) => url.includes("sort=-providerName"))).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: /requester/i }));
    await waitFor(() => {
      expect(feedbackUrls(mockFetch).some((url) => url.includes("sort=requesterName"))).toBe(true);
    });
  });

  test("pagination and page size controls update the query", async () => {
    setupMocks(mockFetch, feedbacksPage(SEED_FEEDBACKS, 45));
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    expect(screen.getByText("45 total")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => {
      expect(feedbackUrls(mockFetch).some((url) => url.includes("page=2"))).toBe(true);
    });

    fireEvent.click(screen.getByLabelText("Rows per page", { selector: "input" }));
    fireEvent.click(await screen.findByRole("option", { name: "40 / page" }));
    await waitFor(() => {
      const url = feedbackUrls(mockFetch).find((u) => u.includes("pageSize=40"));
      expect(url).toBeDefined();
      expect(url).toContain("page=1");
    });
  });

  test("shows empty state when there is no feedback", async () => {
    setupMocks(mockFetch, feedbacksPage([]));
    renderWithProviders(<FeedbackTable view="received" />);

    expect(await screen.findByText(/no feedback/i)).toBeInTheDocument();
  });

  test("shows an error alert when the request fails", async () => {
    setupMocks(mockFetch, jsonResponse(500, { error: "internal", message: "boom" }));
    renderWithProviders(<FeedbackTable view="received" />);

    expect(await screen.findByText(/failed to load feedbacks/i)).toBeInTheDocument();
  });

  test("within() sanity: rows are ordered as returned by the API", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Alice Provider")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Bob Provider (deleted)")).toBeInTheDocument();
  });

  test("the received view has no Edit links", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    await screen.findByText("Alice Provider");
    expect(screen.queryByRole("link", { name: /edit feedback for/i })).not.toBeInTheDocument();
  });

  test("the received view shows a View link per row pointing at the read-only route", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="received" />);

    const viewLinks = await screen.findAllByRole("link", { name: /view feedback from/i });
    expect(viewLinks).toHaveLength(2);
    // Party names no longer ride the URL (v2.35.0) — the view screen renders the record's own.
    expect(
      screen.getByRole("link", { name: /view feedback from bob provider/i }),
    ).toHaveAttribute("href", "/feedback/2/view");
    expect(
      screen.getByRole("link", { name: /view feedback from alice provider/i }),
    ).toHaveAttribute("href", "/feedback/1/view");
  });
});

describe("FeedbackTable (provided view)", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLE_KEY, "[]");
    // A non-party id so the seeded subjects render as names; the "You" case has its own test.
    localStorage.setItem(USER_ID_KEY, "99");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("shows the Subject column, fetches view=provided and defaults to sort=subjectName", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="provided" />);

    expect(await screen.findByText("Sam Subject")).toBeInTheDocument();
    expect(screen.getByText("Tina Subject (deleted)")).toBeInTheDocument();
    expect(screen.queryByText("Alice Provider")).not.toBeInTheDocument();

    const urls = feedbackUrls(mockFetch);
    expect(urls[0]).toContain("view=provided");
    expect(urls[0]).toContain("sort=subjectName");
  });

  test("lists every recipient of a multi-recipient row and names them all in the action aria", async () => {
    setupMocks(
      mockFetch,
      feedbacksPage([
        {
          ...SEED_FEEDBACKS[0],
          subjects: [
            { id: 7, name: "Sam Subject", deleted: false },
            { id: 12, name: "Ben Buddy", deleted: false },
          ],
        },
      ]),
    );
    renderWithProviders(<FeedbackTable view="provided" />);

    expect(await screen.findByText("Sam Subject")).toBeInTheDocument();
    expect(screen.getByText("Ben Buddy")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View feedback for Sam Subject, Ben Buddy" }),
    ).toBeInTheDocument();
  });

  test("shows 'You' in the Subject column when the subject is the current user", async () => {
    // The first seeded row has subjectId 7 — make that the caller.
    localStorage.setItem(USER_ID_KEY, "7");
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="provided" />);

    expect(await screen.findByText("You")).toBeInTheDocument();
    expect(screen.queryByText("Sam Subject")).not.toBeInTheDocument();
    // The other row's subject (a different user) still shows its name.
    expect(screen.getByText("Tina Subject (deleted)")).toBeInTheDocument();
  });

  test("typing in the Subject filter triggers a refetch with subjectName=", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="provided" />);

    await screen.findByText("Sam Subject");
    await user.click(screen.getByRole("button", { name: /filters/i }));
    await user.type(screen.getByLabelText("Subject"), "tina");

    await waitFor(
      () => {
        expect(feedbackUrls(mockFetch).some((url) => url.includes("subjectName=tina"))).toBe(true);
      },
      { timeout: 1500 },
    );
  });

  test("visibility filter offers all four values", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="provided" />);

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByLabelText("Visibility", { selector: "input" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Provider + subject",
      "Provider + requester",
      "Provider + requester + subject",
      "Public",
    ]);
  });

  test("clicking the Subject header toggles to sort=-subjectName", async () => {
    setupMocks(mockFetch);
    const user = userEvent.setup();
    renderWithProviders(<FeedbackTable view="provided" />);

    await screen.findByText("Sam Subject");
    await user.click(screen.getByRole("button", { name: /subject/i }));

    await waitFor(() => {
      expect(feedbackUrls(mockFetch).some((url) => url.includes("sort=-subjectName"))).toBe(true);
    });
  });

  test("shows an Edit link only on DRAFT rows pointing at the edit route", async () => {
    setupMocks(mockFetch);
    renderWithProviders(<FeedbackTable view="provided" />);

    // Row 2 (Tina) is DRAFT; row 1 (Sam) is SENT.
    const editLinks = await screen.findAllByRole("link", { name: /edit feedback for/i });
    expect(editLinks).toHaveLength(1);
    expect(editLinks[0]).toHaveAttribute("href", "/feedback/2/edit");
    expect(
      screen.queryByRole("link", { name: /edit feedback for sam subject/i }),
    ).not.toBeInTheDocument();
  });
});
