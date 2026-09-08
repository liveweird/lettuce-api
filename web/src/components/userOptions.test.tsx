import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import { renderUserOption, userOption } from "./userOptions";

describe("userOption", () => {
  test("builds the option's keywords by joining the team names", () => {
    expect(userOption(8, "Sam Subordinate", ["alpha", "beta"])).toEqual({
      value: "8",
      label: "Sam Subordinate",
      teamNames: ["alpha", "beta"],
      keywords: "alpha beta",
    });
  });

  test("a teamless person gets empty teamNames and keywords", () => {
    expect(userOption(9, "Bob Brown", [])).toEqual({
      value: "9",
      label: "Bob Brown",
      teamNames: [],
      keywords: "",
    });
  });
});

describe("renderUserOption", () => {
  test("shows the name and a dimmed team-names subtitle when teams exist", () => {
    renderWithProviders(
      renderUserOption({ option: userOption(1, "Ann", ["Team AAA", "Team BBB"]) }),
    );
    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.getByText("Team AAA · Team BBB")).toBeInTheDocument();
  });

  test("renders just the name for a teamless person — no empty subtitle line", () => {
    renderWithProviders(renderUserOption({ option: userOption(2, "Ben", []) }));
    expect(screen.getByText("Ben")).toBeInTheDocument();
    expect(screen.queryByText("·")).not.toBeInTheDocument();
  });
});
