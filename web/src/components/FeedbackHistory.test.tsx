import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import FeedbackHistory from "./FeedbackHistory";
import { jsonResponse } from "../test/http";

const TOKEN_KEY = "lettuce.auth.token";

type FetchMock = ReturnType<typeof vi.fn>;


describe("FeedbackHistory", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("renders structured events localized, with translated status/visibility labels", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        items: [
          { id: 1, feedbackId: 5, userId: 10, userName: "Paula", timestamp: 1, type: "CREATED", params: { status: "DRAFT" } },
          { id: 2, feedbackId: 5, userId: 10, userName: "Paula", timestamp: 2, type: "STATUS_CHANGED", params: { from: "DRAFT", to: "SENT" } },
          { id: 3, feedbackId: 5, userId: 10, userName: "Paula", timestamp: 3, type: "VISIBILITY_CHANGED", params: { to: "PUBLIC" } },
          { id: 4, feedbackId: 5, userId: 10, userName: "Paula", timestamp: 4, type: "DELETED", params: {} },
        ],
      }),
    );
    renderWithProviders(<FeedbackHistory feedbackId={5} />);

    // CREATED uses the status-context phrasing; STATUS/VISIBILITY interpolate translated labels.
    expect(await screen.findByText("Feedback created as a draft.")).toBeInTheDocument();
    expect(screen.getByText("Status changed from Draft to Sent.")).toBeInTheDocument();
    expect(screen.getByText("Visibility changed to Public.")).toBeInTheDocument();
    expect(screen.getByText("Feedback deleted.")).toBeInTheDocument();
    expect(screen.getAllByText(/Paula/).length).toBeGreaterThan(0);
  });

  test("renders the auto-expiry sentence for a REQUEST_EXPIRED event, with the system label as actor (never the provider's name)", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        items: [
          { id: 1, feedbackId: 5, userId: 10, userName: "Paula", timestamp: 1, type: "REQUEST_EXPIRED", params: {} },
        ],
      }),
    );
    renderWithProviders(<FeedbackHistory feedbackId={5} />);

    expect(await screen.findByText("The feedback request expired.")).toBeInTheDocument();
    // The event is stored against the provider (Paula) for schema reasons only — the automated
    // flip must render as "Automatic", never her name.
    expect(await screen.findByText(/Automatic/)).toBeInTheDocument();
    expect(screen.queryByText(/Paula/)).toBeNull();
  });

  test("shows an empty-state note when there are no events", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { items: [] }));
    renderWithProviders(<FeedbackHistory feedbackId={5} />);

    expect(await screen.findByText("No history yet.")).toBeInTheDocument();
  });

  test("a failed history load shows an error instead of the empty-history note", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { status: 500 }));
    renderWithProviders(<FeedbackHistory feedbackId={5} />);

    expect(await screen.findByText("Loading failed (500).")).toBeInTheDocument();
    expect(screen.queryByText("No history yet.")).toBeNull();
  });
});
