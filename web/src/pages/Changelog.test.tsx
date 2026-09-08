import { afterEach, describe, expect, test } from "vitest";
import Changelog from "./Changelog";
import { CHANGELOG } from "../changelog/entries";
import { APP_VERSION } from "../changelog/version";
import i18n from "../i18n";
import { renderWithProviders, screen } from "../test/render";

const STORAGE_KEY = "lettuce.changelog";

// Every test here renders the WHOLE changelog timeline, and "renders one timeline entry per
// version" then loops a getByText per entry — O(entries) queries that grow with each release. It
// runs ~1.2s locally but has hit ~6.9s on the loaded CI runner, tripping the 5s default. Bump the
// whole suite's timeout (collector-options form) so a slow runner doesn't flake the gate.
describe("Changelog", { timeout: 15_000 }, () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  test("renders one timeline entry per version with its date", () => {
    renderWithProviders(<Changelog />, { route: "/changelog" });
    expect(screen.getByRole("heading", { level: 2, name: "Changelog" })).toBeInTheDocument();
    for (const entry of CHANGELOG) {
      expect(screen.getByText(`v${entry.version}`)).toBeInTheDocument();
      // Same-day releases repeat a date, so match at-least-one rather than exactly-one.
      expect(screen.getAllByText(entry.date).length).toBeGreaterThan(0);
    }
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
