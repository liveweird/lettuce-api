import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ViewFeedback from "./ViewFeedback";
import { jsonResponse } from "../test/http";

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;


function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{`${location.pathname}${location.search}`}</div>;
}

// Party names come from the RECORD — the URL name params are gone (v2.35.0).
const FEEDBACK = {
  id: 5,
  requesterId: null,
  subjectId: 7,
  providerId: 10,
  providerName: "Alice",
  visibility: "PUBLIC",
  status: "SENT",
  content: "Nice work on the launch",
};

function renderViewFeedback(query = "?providerName=Alice", id = "5") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/feedback/${id}/view${query}`]}>
          <Routes>
            <Route path="/feedback/:id/view" element={<ViewFeedback />} />
            <Route path="/feedback" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("ViewFeedback page", () => {
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

  test("renders the feedback read-only with a Close link to the received tab", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, FEEDBACK));
    renderViewFeedback();

    // The identity strip (v3.5.0): each party renders as a chip or "You" under its label;
    // the status/visibility pills sit in the page header.
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("Recipients")).toBeInTheDocument();
    // No requester on this feedback → no Requester cell.
    expect(screen.queryByText("Requester")).toBeNull();
    expect(screen.getByLabelText("Visibility")).toHaveTextContent("Public");
    expect(screen.getByLabelText("Status")).toHaveTextContent("Sent");
    // Content renders as read-only markdown, not an editable form control.
    expect(screen.getByText("Nice work on the launch")).toBeInTheDocument();
    // No requester message on this feedback → no message toggle.
    expect(screen.queryByText("Message from the requester")).toBeNull();

    // Everything is read-only: there is no editable Content control nor a Save control, only Close.
    expect(screen.queryByRole("textbox", { name: /content/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /close/i })).toHaveAttribute(
      "href",
      "/feedback?tab=received",
    );
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();

    // Only the GET was issued — no mutations.
    expect(
      mockFetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
    ).toBe(true);
  });

  test("shows the requester's message behind a collapsed toggle when present", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...FEEDBACK, requesterMessage: "Please focus on delivery" }),
    );
    const user = userEvent.setup();
    renderViewFeedback();

    const toggle = await screen.findByRole("button", { name: "Message from the requester" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Please focus on delivery")).toBeVisible();
  });

  test("renders the feedback history timeline from the events endpoint", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("/events")) {
        return Promise.resolve(
          jsonResponse(200, {
            items: [
              { id: 1, feedbackId: 5, userId: 10, userName: "Alice Provider", timestamp: 1, type: "CREATED", params: { status: "DRAFT" } },
              { id: 2, feedbackId: 5, userId: 10, userName: "Alice Provider", timestamp: 2, type: "STATUS_CHANGED", params: { from: "DRAFT", to: "SENT" } },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderViewFeedback();

    // Content is the default tab; switch to History to see the timeline.
    await user.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("Feedback created as a draft.")).toBeInTheDocument();
    expect(screen.getByText("Status changed from Draft to Sent.")).toBeInTheDocument();
  });

  test("renders the Lifecycle tab with the state diagram", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, FEEDBACK));
    const user = userEvent.setup();
    renderViewFeedback();

    await user.click(await screen.findByRole("tab", { name: "Lifecycle" }));
    expect(await screen.findByRole("img", { name: /lifecycle/i })).toBeInTheDocument();
  });

  test("the people line names the requester when there is one", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...FEEDBACK, requesterId: 9, requesterName: "Rita Requester" }),
    );
    renderViewFeedback();

    // The requester gets their own labelled cell in the identity strip.
    expect(await screen.findByText("Requester")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Rita Requester")).toBeInTheDocument();
  });

  test("404 shows a not-found alert with a Close link", async () => {
    mockFetch.mockResolvedValue(jsonResponse(404, { error: "not_found", message: "missing" }));
    renderViewFeedback();

    expect(await screen.findByText(/feedback not found/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /close/i })).toHaveAttribute(
      "href",
      "/feedback?tab=received",
    );
  });

  test("403 load shows a permission message", async () => {
    mockFetch.mockResolvedValue(jsonResponse(403, { error: "forbidden", message: "no" }));
    renderViewFeedback();

    expect(await screen.findByText(/don't have permission to view this feedback/i)).toBeInTheDocument();
  });

  test("a non-404/403 load error shows the generic failed message", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { error: "internal", message: "boom" }));
    renderViewFeedback();

    expect(await screen.findByText(/failed to load feedback \(500\)/i)).toBeInTheDocument();
  });

  test("an invalid id redirects to the received tab", () => {
    renderViewFeedback("", "abc");
    expect(screen.getByTestId("probe")).toHaveTextContent("/feedback?tab=received");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("the provider sees 'You' in the people line; as=provider Close links to the provided tab", async () => {
    // Identity, not the as= hint, drives the "You" substitution: caller (7) is the provider.
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...FEEDBACK, providerId: 7, subjectId: 8, subjectName: "Mona" }),
    );
    renderViewFeedback("?as=provider");

    expect(await screen.findByText("You")).toBeInTheDocument();
    expect(screen.getByText("Mona")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /close/i })).toHaveAttribute(
      "href",
      "/feedback?tab=provided",
    );
  });

  test("the people line lists every recipient, the caller among them as You", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...FEEDBACK,
        subjects: [
          { id: 8, name: "Mona", deleted: false },
          { id: 7, name: "Myself", deleted: false },
        ],
      }),
    );
    renderViewFeedback();

    expect(await screen.findByText("Mona")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByText("Myself")).toBeNull();
  });

  test("the requester sees 'You' in the people line", async () => {
    // Caller (7) is the requester → "You", regardless of the resolved requesterName.
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...FEEDBACK,
        subjectId: 8,
        requesterId: 7,
        requesterName: "Rita Requester",
      }),
    );
    renderViewFeedback();

    // The Requester cell renders, with the requester substituted by plain "You".
    expect(await screen.findByText("Requester")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByText("Rita Requester")).toBeNull();
  });

  test("as=team Close links to the team tab", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, FEEDBACK));
    renderViewFeedback("?as=team&subjectName=Mona");

    await screen.findByLabelText("Status");
    expect(screen.getByRole("link", { name: /close/i })).toHaveAttribute(
      "href",
      "/feedback?tab=team",
    );
  });

  test("an explicit back param overrides the tab default for the Close link", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, FEEDBACK));
    const back = encodeURIComponent("/users/10/feedbacks?name=Alice");
    renderViewFeedback(`?providerName=Alice&back=${back}`);

    await screen.findByLabelText("Status");
    expect(screen.getByRole("link", { name: /close/i })).toHaveAttribute(
      "href",
      "/users/10/feedbacks?name=Alice",
    );
  });

  test("the provider can advance the status and is navigated back", async () => {
    // Caller is the provider (userId === providerId), status SENT → next action is Withdraw.
    localStorage.setItem(USER_ID_KEY, "10");
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url === "/api/v1/feedbacks/5/withdraw") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderViewFeedback();

    // Withdrawing is gated behind a confirmation modal.
    await user.click(await screen.findByRole("button", { name: /^withdraw$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^withdraw$/i }));

    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("/feedback?tab=received"),
    );
    const withdraw = mockFetch.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/feedbacks/5/withdraw" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(withdraw).toBeDefined();
  });

  test("a rejected transition surfaces an action error and does not navigate", async () => {
    localStorage.setItem(USER_ID_KEY, "10");
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url === "/api/v1/feedbacks/5/withdraw") {
        return Promise.resolve(jsonResponse(409, { error: "conflict", message: "no" }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderViewFeedback();

    await user.click(await screen.findByRole("button", { name: /^withdraw$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^withdraw$/i }));

    expect(await screen.findByText(/this status change is not allowed/i)).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).not.toBeInTheDocument();
  });

  test("a non-provider sees no status-transition action", async () => {
    // Caller (userId 7) is the subject, not the provider → no action button.
    mockFetch.mockResolvedValue(jsonResponse(200, FEEDBACK));
    renderViewFeedback();

    await screen.findByLabelText("Status");
    expect(screen.queryByRole("button", { name: /^withdraw$/i })).not.toBeInTheDocument();
  });

  test("a requester viewing a REQUESTED feedback sees no Content section", async () => {
    // Caller (userId 7) is the requester; a never-drafted request has nothing to read.
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...FEEDBACK,
        requesterId: 7,
        status: "REQUESTED",
        content: "should not show",
      }),
    );
    renderViewFeedback();

    // Other fields still render, but Content (label + body) is gone.
    expect(await screen.findByLabelText("Status")).toHaveTextContent("Requested");
    expect(screen.getByText("Content isn't available yet.")).toBeInTheDocument();
    expect(screen.queryByText("should not show")).not.toBeInTheDocument();
  });

  test("a requester viewing a REJECTED feedback sees no Content section", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...FEEDBACK,
        requesterId: 7,
        status: "REJECTED",
        content: "should not show",
      }),
    );
    renderViewFeedback();

    expect(await screen.findByLabelText("Status")).toHaveTextContent("Rejected");
    expect(screen.getByText("Content isn't available yet.")).toBeInTheDocument();
    expect(screen.queryByText("should not show")).not.toBeInTheDocument();
  });

  test("a requester viewing a DRAFT feedback sees no Content section", async () => {
    // Caller (userId 7) is the requester watching a draft in progress; the server redacts the
    // content and the page hides the (now empty) Content section.
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...FEEDBACK,
        requesterId: 7,
        status: "DRAFT",
        content: "",
      }),
    );
    renderViewFeedback();

    expect(await screen.findByLabelText("Status")).toHaveTextContent("Draft");
    expect(screen.getByText("Content isn't available yet.")).toBeInTheDocument();
  });

  test("a non-requester viewing a DRAFT feedback still sees Content", async () => {
    // A manager (userId 7) who did not request this draft (requesterId 9, subject 8) still sees
    // its content — the gate is requester-scoped.
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...FEEDBACK,
        requesterId: 9,
        subjectId: 8,
        status: "DRAFT",
        content: "Draft visible to manager",
      }),
    );
    renderViewFeedback("?as=team&subjectName=Sam");

    expect(await screen.findByText("Content")).toBeInTheDocument();
    expect(screen.getByText("Draft visible to manager")).toBeInTheDocument();
  });

  test("a requester viewing a SENT feedback still sees Content", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...FEEDBACK, requesterId: 7, status: "SENT", content: "Delivered note" }),
    );
    renderViewFeedback();

    expect(await screen.findByText("Content")).toBeInTheDocument();
    expect(screen.getByText("Delivered note")).toBeInTheDocument();
  });

  test("a REQUESTED feedback with an expiration shows the deadline row", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...FEEDBACK, status: "REQUESTED", expiresOn: "2099-06-15" }),
    );
    renderViewFeedback();

    expect(await screen.findByText("Expires on")).toBeInTheDocument();
    expect(screen.getByText("Jun 15, 2099")).toBeInTheDocument();
  });

  test("a REQUESTED feedback with no expiration shows no deadline row", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ...FEEDBACK, status: "REQUESTED" }));
    renderViewFeedback();

    await screen.findByLabelText("Status");
    expect(screen.queryByText("Expires on")).toBeNull();
  });

  test("a SENT feedback with an expiration value does not show the deadline row", async () => {
    // expiresOn is inert once the row leaves REQUESTED (set-once, never editable).
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...FEEDBACK, status: "SENT", expiresOn: "2099-06-15" }),
    );
    renderViewFeedback();

    await screen.findByLabelText("Status");
    expect(screen.queryByText("Expires on")).toBeNull();
  });

  test("a non-requester viewing a REQUESTED feedback still sees Content", async () => {
    // Caller (userId 7) is not the requester (requesterId 9) → the gate does not apply.
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...FEEDBACK,
        requesterId: 9,
        status: "REQUESTED",
        content: "Still visible",
      }),
    );
    renderViewFeedback();

    expect(await screen.findByText("Content")).toBeInTheDocument();
    expect(screen.getByText("Still visible")).toBeInTheDocument();
  });
});
