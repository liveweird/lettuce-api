import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EditFeedback from "./EditFeedback";
import { jsonResponse } from "../test/http";

// Swap the Lexical-based editor for a plain textarea (see mockMarkdownEditor). Import inside the
// (hoisted) factory to avoid the top-level-variable restriction.
vi.mock("../components/MarkdownEditor", async () => (await import("../test/mockMarkdownEditor")).mockMarkdownEditorModule());

const TOKEN_KEY = "lettuce.auth.token";
const ROLE_KEY = "lettuce.auth.roles";
const USER_ID_KEY = "lettuce.auth.userId";

type FetchMock = ReturnType<typeof vi.fn>;

function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{`${location.pathname}${location.search}`}</div>;
}


// The subject's name comes from the RECORD — the URL name params are gone (v2.35.0).
const FEEDBACK = {
  id: 5,
  requesterId: null,
  subjectId: 8,
  subjectName: "Mona",
  providerId: 7,
  visibility: "PROVIDER_SUBJECT",
  status: "DRAFT",
  content: "Initial thoughts",
};

// A pending request (provider = caller 7). The detail endpoint resolves party names.
const REQUESTED_FEEDBACK = {
  id: 5,
  requesterId: 9,
  subjectId: 8,
  providerId: 7,
  visibility: "PROVIDER_REQUESTER_SUBJECT",
  status: "REQUESTED",
  content: "",
  requesterMessage: "Please assess my Q3 delivery",
  requesterName: "Rita Requester",
  subjectName: "Sam Subject",
  providerName: "Pat Provider",
};
const ACCEPTED_DRAFT = { ...REQUESTED_FEEDBACK, status: "DRAFT" };

function renderEditFeedback(query = "?subjectName=Mona") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/feedback/5/edit${query}`]}>
          <Routes>
            <Route path="/feedback/:id/edit" element={<EditFeedback />} />
            <Route path="/feedback" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("EditFeedback page", () => {
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

  test("pre-fills the form from the loaded feedback", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, FEEDBACK));
    renderEditFeedback();

    expect((await screen.findByLabelText("Content", { selector: "textarea" })) as HTMLTextAreaElement).toHaveValue(
      "Initial thoughts",
    );
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Mona")).toBeInTheDocument();
    expect((screen.getByPlaceholderText("Select visibility") as HTMLInputElement).value).toBe(
      "Provider + subject",
    );
    // No requester on this feedback → no "requested by" clause in the people line.
    expect(screen.queryByText(/requested by/)).toBeNull();
    // Editing an existing draft must never fire the create screens' duplicate check —
    // the loaded feedback IS the record such a check would find.
    expect(
      mockFetch.mock.calls.every(([u]) => !String(u).includes("duplicate-check")),
    ).toBe(true);
  });

  test("a self-reflection draft renders the subject as plain You, not a chip", async () => {
    // provider == subject == caller (7): both sides of the people line are the current user.
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...FEEDBACK, subjectId: 7, subjectName: "Pat Provider" }),
    );
    renderEditFeedback("");

    await screen.findByLabelText("Content", { selector: "textarea" });
    expect(screen.getAllByText("You")).toHaveLength(2);
    // The caller's own name must not appear as an avatar chip in the header.
    expect(screen.queryByText("Pat Provider")).toBeNull();
  });

  test("a requested self-reflection triages with You as subject and self wording", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        ...REQUESTED_FEEDBACK,
        subjectId: 7,
        subjectName: "Pat Provider",
      }),
    );
    renderEditFeedback("");

    expect(
      await screen.findByText(/Rita Requester asked you for a self-reflection/),
    ).toBeInTheDocument();
    // Subject field renders plain "You"; the requester still gets a named chip.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Rita Requester")).toBeInTheDocument();
    expect(screen.queryByText("Pat Provider")).toBeNull();
    // Still a triage decision screen, not the editor.
    expect(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  test("Delete on a draft confirms, issues DELETE, and returns to the provided tab", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && url === "/api/v1/feedbacks/5") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByLabelText("Content", { selector: "textarea" });
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("/feedback?tab=provided"),
    );
    const del = mockFetch.mock.calls.find(
      ([url, init]) => url === "/api/v1/feedbacks/5" && (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(del).toBeDefined();
  });

  test("no Delete button when the caller is not the draft's provider", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ...FEEDBACK, providerId: 99 }));
    renderEditFeedback();

    await screen.findByLabelText("Content", { selector: "textarea" });
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();
  });

  test("with a requester, visibility offers the requester options and shows a read-only Requester", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, ACCEPTED_DRAFT));
    const user = userEvent.setup();
    renderEditFeedback();

    // ACCEPTED_DRAFT is a DRAFT with a requester, so the editor (not the triage screen) renders.
    const visibility = (await screen.findByPlaceholderText(
      "Select visibility",
    )) as HTMLInputElement;
    expect(visibility.value).toBe("Provider + requester + subject");

    // The resolved requester name is shown in the context strip (v3.5.0).
    expect(screen.getByText("Requester")).toBeInTheDocument();
    expect(screen.getByText("Rita Requester")).toBeInTheDocument();

    // The requester's clarification message is carried into the editor behind a collapsed toggle.
    const messageToggle = screen.getByRole("button", { name: "Message from the requester" });
    expect(messageToggle).toHaveAttribute("aria-expanded", "false");
    await user.click(messageToggle);
    expect(await screen.findByText("Please assess my Q3 delivery")).toBeInTheDocument();

    await user.click(visibility);
    // The Template select's listbox is empty here, so the only options in the DOM are visibility's.
    const options = (await screen.findAllByRole("option", { hidden: true })).map(
      (o) => o.textContent,
    );
    expect(options).toEqual([
      "Provider + requester",
      "Provider + requester + subject",
      "Public",
    ]);
  });

  test("Save draft PUTs content and visibility only", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT" && url === "/api/v1/feedbacks/5") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    const content = (await screen.findByLabelText("Content", { selector: "textarea" })) as HTMLTextAreaElement;
    await user.clear(content);
    await user.type(content, "Revised note");
    await user.click(screen.getByRole("button", { name: /^save draft$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/feedback?tab=provided"));

    const put = mockFetch.mock.calls.find(
      ([url, init]) => url === "/api/v1/feedbacks/5" && (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeDefined();
    expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
      visibility: "PROVIDER_SUBJECT",
      content: "Revised note",
    });
  });

  test("a 403 on save shows a permission error and stays on the editor", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT" && url === "/api/v1/feedbacks/5") {
        return Promise.resolve(jsonResponse(403, { error: "forbidden", message: "no" }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByLabelText("Content", { selector: "textarea" });
    await user.click(screen.getByRole("button", { name: /^save draft$/i }));

    expect(await screen.findByText(/don't have permission to edit this feedback/i)).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).toBeNull(); // no navigation on error
  });

  test("a 400 on save shows a validation error and stays on the editor", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT" && url === "/api/v1/feedbacks/5") {
        return Promise.resolve(jsonResponse(400, { error: "bad_request", message: "no" }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByLabelText("Content", { selector: "textarea" });
    await user.click(screen.getByRole("button", { name: /^save draft$/i }));

    expect(await screen.findByText(/validation error/i)).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  test("a 400 on delete shows the not-draft error and stays on the editor", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE" && url === "/api/v1/feedbacks/5") {
        return Promise.resolve(jsonResponse(400, { error: "bad_request", message: "no" }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByLabelText("Content", { selector: "textarea" });
    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/only drafts can be deleted/i)).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  test("Save & send PUTs the content then POSTs /send", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && url === "/api/v1/feedbacks/5") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === "POST" && url === "/api/v1/feedbacks/5/send") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse(200, FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByLabelText("Content", { selector: "textarea" });
    await user.click(screen.getByRole("button", { name: /save & send/i }));

    await waitFor(() => {
      const send = mockFetch.mock.calls.find(
        ([url, init]) =>
          url === "/api/v1/feedbacks/5/send" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(send).toBeDefined();
    });
    const put = mockFetch.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/feedbacks/5" && (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
      visibility: "PROVIDER_SUBJECT",
      content: "Initial thoughts",
    });
  });

  test("Cancel → Discard returns to the provided tab without saving", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, FEEDBACK));
    const user = userEvent.setup();
    renderEditFeedback();

    // The guard asks only once there is work to lose (v3.5.0).
    await user.type(await screen.findByLabelText("Content", { selector: "textarea" }), " edited");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("link", { name: /^discard$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/feedback?tab=provided"));
    const put = mockFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeUndefined();
  });

  test("404 on load shows a not-found alert with a back link", async () => {
    mockFetch.mockResolvedValue(jsonResponse(404, { error: "not_found", message: "missing" }));
    renderEditFeedback();

    expect(await screen.findByText(/feedback not found/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to feedback/i })).toHaveAttribute(
      "href",
      "/feedback?tab=provided",
    );
  });

  test("a REQUESTED feedback shows the decision screen, not the editor", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, REQUESTED_FEEDBACK));
    renderEditFeedback();

    await screen.findByRole("heading", { name: /feedback request/i });
    // No editor in this state.
    expect(screen.queryByLabelText("Content")).toBeNull();
    expect(screen.queryByRole("button", { name: /save & send/i })).toBeNull();
    // The three decision actions, with the resolved requester name.
    expect(screen.getByRole("button", { name: /^accept$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument();
    expect(screen.getByText("Rita Requester")).toBeInTheDocument();
    // The requester's clarification message is shown read-only on the triage screen.
    const message = screen.getByLabelText("Message from the requester") as HTMLTextAreaElement;
    expect(message).toHaveValue("Please assess my Q3 delivery");
    expect(message).toHaveAttribute("readonly");
  });

  test("a requested feedback with an expiration shows the deadline on the triage screen", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { ...REQUESTED_FEEDBACK, expiresOn: "2099-06-15" }),
    );
    renderEditFeedback();

    await screen.findByRole("heading", { name: /feedback request/i });
    expect(screen.getByText("Expires on")).toBeInTheDocument();
    expect(screen.getByText("Jun 15, 2099")).toBeInTheDocument();
  });

  test("a requested feedback with no expiration shows no deadline on the triage screen", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, REQUESTED_FEEDBACK));
    renderEditFeedback();

    await screen.findByRole("heading", { name: /feedback request/i });
    expect(screen.queryByText("Expires on")).toBeNull();
  });

  test("Accept POSTs /pick-up and reloads in place as the editor", async () => {
    let accepted = false;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && url === "/api/v1/feedbacks/5/pick-up") {
        accepted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse(200, accepted ? ACCEPTED_DRAFT : REQUESTED_FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByRole("heading", { name: /feedback request/i });
    await user.click(screen.getByRole("button", { name: /^accept$/i }));

    // The screen reloads in place into the editor — never navigates away.
    expect(await screen.findByLabelText("Content", { selector: "textarea" })).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).toBeNull();

    const pickUp = mockFetch.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/feedbacks/5/pick-up" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(pickUp).toBeDefined();
  });

  test("Reject → confirm → POSTs /reject and returns to the provided tab", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && url === "/api/v1/feedbacks/5/reject") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse(200, REQUESTED_FEEDBACK));
    });
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByRole("heading", { name: /feedback request/i });
    await user.click(screen.getByRole("button", { name: /^reject$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^reject$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/feedback?tab=provided"));
    const reject = mockFetch.mock.calls.find(
      ([url, init]) =>
        url === "/api/v1/feedbacks/5/reject" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(reject).toBeDefined();
  });

  test("Close returns to the provided tab without saving", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, REQUESTED_FEEDBACK));
    const user = userEvent.setup();
    renderEditFeedback();

    await screen.findByRole("heading", { name: /feedback request/i });
    await user.click(screen.getByRole("button", { name: /^close$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/feedback?tab=provided"));
    const put = mockFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeUndefined();
  });
});
