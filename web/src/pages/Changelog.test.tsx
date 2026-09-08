import { afterEach, describe, expect, test } from "vitest";
import Changelog from "./Changelog";
import { CHANGELOG } from "../changelog/entries";
import { APP_VERSION } from "../changelog/version";
import i18n from "../i18n";
import { renderWithProviders, screen } from "../test/render";

const STORAGE_KEY = "lettuce.changelog";

// Every test here renders the WHOLE changelog timeline. The previous "renders one timeline
// entry per version" looped a getByText per entry — O(entries) queries that grow with each
// release, ~1.2s locally but hit ~6.9s on the loaded CI runner, tripping the 5s default. A
// single count assertion replaced the loop (Checkup #34/C7); the whole suite's timeout stays
// bumped (collector-options form) as a backstop against a slow runner.
describe("Changelog", { timeout: 15_000 }, () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  test("renders one timeline entry per version with its date", () => {
    renderWithProviders(<Changelog />, { route: "/changelog" });
    expect(screen.getByRole("heading", { level: 2, name: "Changelog" })).toBeInTheDocument();
    // One "v<version>" heading per entry — a single count assertion instead of a per-entry loop.
    expect(screen.getAllByText(/^v\d/)).toHaveLength(CHANGELOG.length);
    // Spot-check the newest entry's date renders somewhere in the timeline.
    expect(screen.getAllByText(CHANGELOG[0].date).length).toBeGreaterThan(0);
  });

  test("renders the English bodies by default", () => {
    renderWithProviders(<Changelog />, { route: "/changelog" });
    expect(screen.getByText(/Initial release/)).toBeInTheDocument();
    expect(screen.queryByText(/Pierwsze wydanie/)).not.toBeInTheDocument();
  });

  test("renders the Polish bodies when the language is pl", async () => {
    await i18n.changeLanguage("pl");
    renderWithProviders(<Changelog />, { route: "/changelog" });
    expect(screen.getByRole("heading", { level: 2, name: "Historia zmian" })).toBeInTheDocument();
    expect(screen.getByText(/Pierwsze wydanie/)).toBeInTheDocument();
    expect(screen.queryByText(/Initial release/)).not.toBeInTheDocument();
  });

  test("marks the current version as seen on mount", () => {
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    renderWithProviders(<Changelog />, { route: "/changelog" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ seenVersion: APP_VERSION });
  });

  test("tolerates corrupt stored state and still marks seen", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    renderWithProviders(<Changelog />, { route: "/changelog" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ seenVersion: APP_VERSION });
  });
});
