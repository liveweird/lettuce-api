import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { jsonResponse } from "../test/http";
import CreateDaysOff from "./CreateDaysOff";

type FetchMock = ReturnType<typeof vi.fn>;

const YEAR = 2099;
// Mon 2099-06-01 … the first week of June 2099 (2099-06-01 is a Monday).
const MONDAY = "2099-06-01";
const TUESDAY = "2099-06-02";

function budget(remaining: number, allowance: number | null = 20) {
  return {
    userId: 5, userName: "Me", userDeleted: false, year: YEAR,
    poolId: 41, poolTypeId: 1, poolName: "Paid days off", carriesOver: true, isDefault: true, poolArchived: false,
    allowance, carriedOver: 0, corrected: 0, reserved: 0, used: 0, remaining, canCorrect: false,
  };
}

// An extra, non-carry-over pool (v3.2.0) the picker offers beside the default one.
const STUDY_POOL = {
  ...budget(2, 3),
  poolId: 42, poolTypeId: 7, poolName: "Study leave", carriesOver: false, isDefault: false,
};

function renderPage(entry = "/days-off/new") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider env="test">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/days-off/new" element={<CreateDaysOff />} />
            <Route path="/days-off" element={<div>LIST</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("CreateDaysOff", () => {
  let mockFetch: FetchMock;

  function setupMocks({
    remaining = 10,
    allowance = 20 as number | null,
    holidays = [] as { id: number; date: string; name: string }[],
    createStatus = 201,
    createBody = {} as unknown,
    extraPools = [] as (typeof STUDY_POOL)[],
  } = {}) {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          createStatus === 201
            ? jsonResponse(201, { id: 77 })
            : jsonResponse(createStatus, createBody),
        );
      }
      if (u.includes("/api/v1/public-holidays")) {
        return Promise.resolve(jsonResponse(200, { items: holidays }));
      }
      if (u.includes("/api/v1/days-off/budgets")) {
        // The managed view backs the on-behalf picker's preview: the caller's two reports.
        if (u.includes("view=managed")) {
          return Promise.resolve(
            jsonResponse(200, {
              items: [
                { ...budget(remaining, allowance), userId: 9, userName: "Rita Report" },
                { ...budget(3, allowance), userId: 11, userName: "Zed Report" },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, { items: [budget(remaining, allowance), ...extraPools] }));
      }
      if (u.includes("/api/v1/teams/members")) {
        const row = (userId: number, name: string) => ({
          userId, name, email: `${name.replaceAll(" ", ".")}@x.test`, teamId: 1, teamName: "Team",
        });
        return Promise.resolve(
          jsonResponse(200, {
            items: [row(5, "Me"), row(9, "Rita Report"), row(11, "Zed Report")],
            page: 1, pageSize: 100, total: 3,
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { items: [] }));
    });
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("lettuce.auth.token", "fake-token");
    localStorage.setItem("lettuce.auth.userId", "5");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  // The typed-ISO DateFields (v3.5.0) parse on change, so fireEvent.change with a full ISO
  // string sets them exactly like the former native type="date" inputs (the CreateGoal idiom).
  async function pickRange(start: string, end: string) {
    fireEvent.change(screen.getByLabelText("From"), { target: { value: start } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: end } });
    await Promise.resolve();
  }

  test("previews the working-day cost with holidays skipped and the remaining budget", async () => {
    setupMocks({ remaining: 10, holidays: [{ id: 1, date: TUESDAY, name: "Holiday" }] });
    renderPage();

    await pickRange(MONDAY, "2099-06-05"); // Mon..Fri with a Tuesday holiday
    expect(await screen.findByText("This request costs 4 working days.")).toBeInTheDocument();
    expect(
      screen.getByText(`Remaining "Paid days off" budget for ${YEAR}: 10.`),
    ).toBeInTheDocument();
  });

  test("the budgets query only runs for a complete start date — a cleared field fires no request (v3.5.2)", async () => {
    setupMocks({ remaining: 10 });
    renderPage();
    await pickRange(MONDAY, TUESDAY);
    expect(await screen.findByText(`Remaining "Paid days off" budget for ${YEAR}: 10.`)).toBeInTheDocument();
    const budgetUrls = () =>
      mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/api/v1/days-off/budgets"));
    const budgetCalls = () => budgetUrls().length;
    const before = budgetCalls();
    expect(before).toBeGreaterThan(0);

    // Clearing the start date used to re-key the query on the current year and refetch —
    // the query is gated on a valid ISO start now, so nothing fires until a date lands.
    await userEvent.clear(screen.getByLabelText("From"));
    expect(screen.getByLabelText("From")).toHaveValue("");
    await Promise.resolve();
    expect(budgetCalls()).toBe(before);
    expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();

    // A complete date re-enables the query (still keyed on the same year) and the preview returns.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: MONDAY } });
    expect(await screen.findByText(`Remaining "Paid days off" budget for ${YEAR}: 10.`)).toBeInTheDocument();
    // Whatever refetched on re-enable is still the typed year — never a fallback one.
    expect(budgetUrls().slice(before).every((u) => u.includes(`year=${YEAR}`))).toBe(true);
  });

  test("the pool picker offers every pool plus Unpaid; an extra pool posts its id and previews its own budget", async () => {
    setupMocks({ remaining: 10, extraPools: [STUDY_POOL] });
    renderPage();

    await pickRange(MONDAY, TUESDAY);
    // The default pool is pre-picked.
    expect(await screen.findByText(`Remaining "Paid days off" budget for ${YEAR}: 10.`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Type" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Paid days off", "Study leave", "Unpaid"]);
    await userEvent.click(screen.getByRole("option", { name: "Study leave" }));
    expect(await screen.findByText(`Remaining "Study leave" budget for ${YEAR}: 2.`)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(screen.getByText("LIST")).toBeInTheDocument());
    const post = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      type: "PAID",
      poolTypeId: 7,
      startDate: MONDAY,
      endDate: TUESDAY,
      startHalf: false,
      endHalf: false,
    });
  });

  test("Unpaid posts no pool and skips the budget preview", async () => {
    setupMocks();
    renderPage();
    await pickRange(MONDAY, TUESDAY);
    await userEvent.click(screen.getByRole("combobox", { name: "Type" }));
    await userEvent.click(await screen.findByRole("option", { name: "Unpaid" }));
    expect(screen.queryByText(/Remaining "/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(screen.getByText("LIST")).toBeInTheDocument());
    const post = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      type: "UNPAID",
      startDate: MONDAY,
      endDate: TUESDAY,
      startHalf: false,
      endHalf: false,
    });
  });

  test("the last-day half checkbox is disabled on a single-day request", async () => {
    setupMocks();
    renderPage();

    await pickRange(MONDAY, MONDAY);
    expect(screen.getByLabelText("Last day is a half day")).toBeDisabled();
    await userEvent.click(screen.getByLabelText("First day is a half day"));
    expect(await screen.findByText("This request costs 0.5 working days.")).toBeInTheDocument();

    await pickRange(MONDAY, TUESDAY);
    expect(screen.getByLabelText("Last day is a half day")).toBeEnabled();
  });

  test("an over-budget PAID request blocks submission with a red hint", async () => {
    setupMocks({ remaining: 1 });
    renderPage();

    await pickRange(MONDAY, "2099-06-04"); // 4 working days > 1 remaining
    expect(
      (await screen.findAllByText("The request does not fit your remaining paid-days budget."))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  });

  test("a weekend-only period warns and blocks", async () => {
    setupMocks();
    renderPage();
    await pickRange("2099-06-06", "2099-06-07"); // Sat..Sun
    expect(
      await screen.findByText("The period contains no working days — only weekends or public holidays."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  });

  test("submits, toasts, and navigates back to the requests tab", async () => {
    const showSpy = vi.spyOn(notifications, "show");
    setupMocks();
    renderPage();

    await pickRange(MONDAY, TUESDAY);
    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    await waitFor(() => expect(screen.getByText("LIST")).toBeInTheDocument());
    const post = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      type: "PAID",
      poolTypeId: 1,
      startDate: MONDAY,
      endDate: TUESDAY,
      startHalf: false,
      endHalf: false,
    });
    expect(showSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Days-off request submitted" }),
    );
  });

  test("Cancel leaves a pristine form at once (v3.5.0)", async () => {
    setupMocks();
    renderPage();

    await screen.findByText("New days-off request");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("LIST")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a report pick makes Cancel ask before discarding (v3.5.0)", async () => {
    setupMocks();
    renderPage("/days-off/new?onBehalf=1");

    await screen.findByText("New days off");
    await userEvent.click(screen.getByRole("combobox", { name: "On behalf of" }));
    await userEvent.click(await screen.findByRole("option", { name: /Rita Report/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Discard changes?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("LIST")).toBeNull();
  });

  test("on-behalf mode offers the report picker (caller excluded) and gates the submit on a pick", async () => {
    setupMocks();
    renderPage("/days-off/new?onBehalf=1");

    expect(await screen.findByText("New days off")).toBeInTheDocument();
    // Valid dates alone don't unlock the auto-accepted submit — a report must be picked.
    await pickRange(MONDAY, TUESDAY);
    const submit = screen.getByRole("button", { name: "Submit auto-accepted" });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole("combobox", { name: "On behalf of" }));
    // Each option's team subtitle rides its accessible name too — matched via a pattern.
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
    expect(options.some((o) => o.includes("Rita Report"))).toBe(true);
    expect(options.some((o) => o.includes("Zed Report"))).toBe(true);
    expect(options.some((o) => o.includes("Me"))).toBe(false);
    await userEvent.click(screen.getByRole("option", { name: /Rita Report/ }));

    expect(submit).toBeEnabled();
    // The budget preview reads the PICKED report's managed-budget row.
    expect(
      await screen.findByText(`Remaining "Paid days off" budget for ${YEAR}: 10.`),
    ).toBeInTheDocument();
    // Both on-behalf fetches run in chain mode (v2.33.0), so a subtree pick still resolves.
    const membersCall = mockFetch.mock.calls.find(([u]) => String(u).includes("/api/v1/teams/members"));
    expect(String(membersCall?.[0])).toContain("includeIndirect=true");
    const budgetsCall = mockFetch.mock.calls.find(([u]) =>
      String(u).includes("/api/v1/days-off/budgets") && String(u).includes("view=managed"),
    );
    expect(String(budgetsCall?.[0])).toContain("includeIndirect=true");
  });

  test("on-behalf submit posts the picked userId, toasts, and returns to the team tab", async () => {
    const showSpy = vi.spyOn(notifications, "show");
    showSpy.mockClear();
    setupMocks();
    renderPage("/days-off/new?onBehalf=1");

    await pickRange(MONDAY, TUESDAY);
    await userEvent.click(screen.getByRole("combobox", { name: "On behalf of" }));
    await userEvent.click(await screen.findByRole("option", { name: /Zed Report/ }));
    await userEvent.click(screen.getByRole("button", { name: "Submit auto-accepted" }));

    await waitFor(() => expect(screen.getByText("LIST")).toBeInTheDocument());
    const post = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      type: "PAID",
      poolTypeId: 1,
      startDate: MONDAY,
      endDate: TUESDAY,
      startHalf: false,
      endHalf: false,
      userId: 11,
    });
    expect(showSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Days off recorded and accepted" }),
    );
  });

  test("an overlap 409 (instance set) and a budget 409 read differently", async () => {
    setupMocks({ createStatus: 409, createBody: { instance: "/api/v1/days-off/3" } });
    renderPage();
    await pickRange(MONDAY, TUESDAY);
    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(
      await screen.findByText("The period overlaps one of your pending or accepted requests."),
    ).toBeInTheDocument();

    setupMocks({ createStatus: 409, createBody: {} });
    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(
      (await screen.findAllByText("The request does not fit your remaining paid-days budget."))
        .length,
    ).toBeGreaterThan(0);
  });

  test("a PAID submit waits for the pool rows — a failed budgets load blocks it, Unpaid still goes through (v3.2.1)", async () => {
    setupMocks();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if ((init?.method ?? "GET") === "POST") return Promise.resolve(jsonResponse(201, { id: 77 }));
      if (u.includes("/api/v1/days-off/budgets")) return Promise.resolve(jsonResponse(500, {}));
      return Promise.resolve(jsonResponse(200, { items: [] }));
    });
    renderPage();
    await pickRange(MONDAY, TUESDAY);
    // No pool row resolved: the picker shows its placeholder, never a misleading "Unpaid".
    const picker = screen.getByRole("combobox", { name: "Type" });
    expect(picker).toHaveValue("");
    expect(picker).toHaveAttribute("placeholder", "Loading pools…");
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled());
    // An explicit Unpaid needs no budget.
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole("option", { name: "Unpaid" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit request" })).toBeEnabled());
  });
});
