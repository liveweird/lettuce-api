import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Dictionary from "./Dictionary";
import { jsonResponse } from "../test/http";

type FetchMock = ReturnType<typeof vi.fn>;

function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{location.pathname}</div>;
}

const ENTRIES: { id: number; values: { en: string; pl?: string } }[] = [
  { id: 1, values: { en: "Engineering", pl: "Inżynieria" } },
  { id: 2, values: { en: "Management", pl: "Zarządzanie" } },
];

function renderPage(route = "/dictionaries/career-paths") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/dictionaries/:slug" element={<Dictionary />} />
            <Route path="*" element={<PathProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("Dictionary page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("lettuce.auth.token", "fake-token");
    localStorage.setItem("lettuce.auth.roles", JSON.stringify(["ADMIN"]));
    localStorage.setItem("lettuce.auth.userId", "1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function stubApi(items = ENTRIES, putStatus = 204) {
    mockFetch.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return Promise.resolve(
          putStatus === 204
            ? new Response(null, { status: 204 })
            : jsonResponse(putStatus, { title: "Conflict", status: putStatus }),
        );
      }
      return Promise.resolve(jsonResponse(200, { items }));
    });
  }

  function putBodies(): { items: { id?: number; values: Record<string, string> }[] }[] {
    return mockFetch.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  }

  test("an unknown slug redirects to the dashboard", async () => {
    stubApi();
    renderPage("/dictionaries/nonsense");

    await waitFor(() => expect(screen.getByTestId("probe")).toBeInTheDocument());
    expect(screen.getByTestId("probe")).toHaveTextContent("/");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("a non-admin sees the ordered read-only list with no editor controls", async () => {
    localStorage.setItem("lettuce.auth.roles", "[]");
    stubApi();
    renderPage();

    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Management")).toBeInTheDocument();
    // The other language no longer stacks inline (v2.23.0) — it sits behind the per-entry
    // language-count badge, which opens a popover naming each translation.
    expect(screen.queryByText("Inżynieria")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Languages of entry 1" }));
    expect(screen.getByText("Polish")).toBeInTheDocument();
    expect(screen.getByText("Inżynieria")).toBeInTheDocument();
    // Ordered numbering in the compact table (v3.4.0), but nothing editable and no
    // dictionary actions.
    expect(screen.getByRole("columnheader", { name: "Value" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Languages" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("1.")).toBeInTheDocument();
    expect(screen.getByText("2.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add entry" })).not.toBeInTheDocument();
    // The editor's column headers don't render in the read-only view.
    expect(screen.queryByText("English")).not.toBeInTheDocument();
  });

  test("the read-only view leads with the viewer's language and falls back to English per entry", async () => {
    localStorage.setItem("lettuce.auth.roles", "[]");
    // One translated entry, one EN-only entry (no Polish translation).
    stubApi([ENTRIES[0], { id: 7, values: { en: "Consulting" } }]);
    const { default: i18n } = await import("../i18n");
    await i18n.changeLanguage("pl");
    try {
      renderPage();

      // The translated entry shows Polish first; English sits behind the languages badge.
      expect(await screen.findByText("Inżynieria")).toBeInTheDocument();
      expect(screen.queryByText("Engineering")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Języki wpisu 1" }));
      expect(screen.getByText("Engineering")).toBeInTheDocument();
      // The EN-only entry falls back to English — rendered once, and with no other filled
      // language it carries no badge at all: the Languages cell is the plain "1 language" count.
      expect(screen.getAllByText("Consulting")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Języki wpisu 2" })).not.toBeInTheDocument();
      expect(screen.getByText("1 język")).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  test("a blank non-EN translation falls back to English (pickLocalized) and is not counted", async () => {
    localStorage.setItem("lettuce.auth.roles", "[]");
    stubApi([{ id: 9, values: { en: "Consulting", pl: "   " } }]);
    const { default: i18n } = await import("../i18n");
    await i18n.changeLanguage("pl");
    try {
      renderPage();

      expect(await screen.findByText("Consulting")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Języki wpisu 1" })).not.toBeInTheDocument();
      expect(screen.getByText("1 język")).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  test("the page titles itself through the shared header (h2) and shows the centered loader while loading", async () => {
    localStorage.setItem("lettuce.auth.roles", "[]");
    let resolveList: (value: Response) => void = () => {};
    mockFetch.mockImplementation(
      () => new Promise<Response>((resolve) => { resolveList = resolve; }),
    );
    renderPage();

    expect(screen.getByRole("heading", { level: 2, name: "Career paths" })).toBeInTheDocument();
    expect(document.querySelector(".mantine-Loader-root")).not.toBeNull();
    resolveList(jsonResponse(200, { items: ENTRIES }));
    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    expect(document.querySelector(".mantine-Loader-root")).toBeNull();
  });

  test("a non-admin with no entries sees the empty state", async () => {
    localStorage.setItem("lettuce.auth.roles", "[]");
    stubApi([]);
    renderPage();

    expect(await screen.findByText("This dictionary has no entries yet.")).toBeInTheDocument();
  });

  test("the admin editor pre-fills entries and Save is disabled until dirty", async () => {
    stubApi();
    renderPage();

    expect(await screen.findByDisplayValue("Engineering")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Management")).toBeInTheDocument();
    // The input columns carry visible language headers (v2.6.1 — the placeholders
    // vanish once filled, so the headers are the only always-visible markers); non-EN
    // columns are marked optional (v2.20.0 — only English is required). Since v2.23.0 the
    // non-EN column is the one picked in the translation-language Select — "Polish" also
    // lives in the picker's mounted listbox, hence getAllByText (the evergreen gotcha).
    expect(screen.getByRole("combobox", { name: "Translation language" })).toHaveValue("Polish");
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getAllByText("Polish").length).toBeGreaterThan(0);
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Cancel is never gated on dirty (the shared discard-guard convention) — it stays
    // clickable and, on a clean form, navigates straight away with no prompt.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  test("adding an entry sends it id-less while existing rows keep their ids", async () => {
    const user = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByDisplayValue("Engineering");
    await user.click(screen.getByRole("button", { name: "Add entry" }));
    await user.type(screen.getByLabelText("Entry 3 (English)"), "Consulting");
    await user.type(screen.getByLabelText("Entry 3 (Polish)"), "Konsulting");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({
      items: [
        { id: 1, values: { en: "Engineering", pl: "Inżynieria" } },
        { id: 2, values: { en: "Management", pl: "Zarządzanie" } },
        { values: { en: "Consulting", pl: "Konsulting" } },
      ],
    });
  });

  test("a new entry with a blank Polish input saves EN-only — the omit-to-clear wire contract", async () => {
    const user = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByDisplayValue("Engineering");
    await user.click(screen.getByRole("button", { name: "Add entry" }));
    await user.type(screen.getByLabelText("Entry 3 (English)"), "Consulting");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0].items[2]).toEqual({ values: { en: "Consulting" } });
  });

  test("reordering and removing rows shape the payload from the visible order", async () => {
    const user = userEvent.setup();
    stubApi([...ENTRIES, { id: 3, values: { en: "Sales", pl: "Sprzedaż" } }]);
    renderPage();

    await screen.findByDisplayValue("Sales");
    await user.click(screen.getByRole("button", { name: "Move entry 3 up" }));
    await user.click(screen.getByRole("button", { name: "Remove entry 1" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]).toEqual({
      items: [
        { id: 3, values: { en: "Sales", pl: "Sprzedaż" } },
        { id: 2, values: { en: "Management", pl: "Zarządzanie" } },
      ],
    });
  });

  test("a duplicate value blocks the save with an inline error", async () => {
    const user = userEvent.setup();
    stubApi();
    renderPage();

    // A duplicate ENGLISH value is flagged even when the Polish side stays unique.
    const second = await screen.findByLabelText("Entry 2 (English)");
    await user.clear(second);
    await user.type(second, "Engineering");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("This value already exists in the dictionary"),
    ).toBeInTheDocument();
    expect(putBodies()).toHaveLength(0);
  });

  test("a 409 from the server surfaces the conflict message", async () => {
    const user = userEvent.setup();
    stubApi(ENTRIES, 409);
    renderPage();

    const first = await screen.findByLabelText("Entry 1 (English)");
    await user.clear(first);
    await user.type(first, "Renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "A value clashes with an existing entry — values must be unique within the dictionary.",
      ),
    ).toBeInTheDocument();
  });

  test("cancel-on-clean navigates without prompting the discard guard", async () => {
    const user = userEvent.setup();
    stubApi();
    renderPage();

    await screen.findByDisplayValue("Engineering");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // No discard confirm on a clean form — requestCancel navigates straight away (a same-page
    // no-op here, since the editor has nowhere else to go) and the loaded values stay put.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue("Engineering")).toBeInTheDocument();
    expect(putBodies()).toHaveLength(0);
  });

  test("a dirty Cancel prompts the discard guard, and discarding restores the loaded values", async () => {
    const user = userEvent.setup();
    stubApi();
    renderPage();

    const first = await screen.findByLabelText("Entry 1 (English)");
    await user.clear(first);
    await user.type(first, "Changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByText("Your unsaved dictionary changes will be lost.")).toBeInTheDocument();
    await user.click(within(modal).getByRole("link", { name: "Discard" }));

    expect(await screen.findByDisplayValue("Engineering")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Changed")).not.toBeInTheDocument();
    expect(putBodies()).toHaveLength(0);
  });

  test("a save whose re-read fails freezes the editor behind a reload prompt", async () => {
    // The PUT commits but the follow-up GET fails: without the minted ids a resubmit would
    // insert duplicates, so the editor freezes (v2.24.0) instead of showing a save error.
    let saved = false;
    mockFetch.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        saved = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (saved) return Promise.resolve(jsonResponse(500, { status: 500 }));
      return Promise.resolve(jsonResponse(200, { items: ENTRIES }));
    });
    renderPage();
    await userEvent.type(await screen.findByLabelText("Entry 1 (English)"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Saved — but reloading the editor failed. Reload the page before making further changes.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });
});
