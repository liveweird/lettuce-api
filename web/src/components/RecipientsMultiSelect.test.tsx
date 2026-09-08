import { describe, expect, test, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import RecipientsMultiSelect from "./RecipientsMultiSelect";
import { userOption } from "./userOptions";

const TEAMS = ["Team AAA", "Team AAA", "Team BBB", "Team BBB", "Team BBB"];
const OPTIONS = ["Ann", "Ben", "Cy", "Di", "Ed"].map((name, i) =>
  userOption(i + 1, name, [TEAMS[i]]),
);

function Harness({ onChange }: { onChange?: (v: string[]) => void }) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <RecipientsMultiSelect
      label="Recipients"
      options={OPTIONS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("RecipientsMultiSelect", () => {
  test("describes the cap on the combobox field and names each pill's remove button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const field = screen.getByRole("combobox", { name: "Recipients" });
    expect(field).toHaveAccessibleDescription("Up to 4 people");
    await user.click(field);
    // The option's accessible name now also carries its dimmed team subtitle — a pattern
    // match, not the exact name — while the pill (via accessibleRenderPill) stays plain.
    await user.click(await screen.findByRole("option", { name: /Ann/, hidden: true }));
    expect(screen.getByRole("button", { name: "Remove Ann" })).toBeInTheDocument();
  });

  test("shows each person's team(s) as a dimmed subtitle and searching a team name filters to it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole("combobox", { name: "Recipients" }));
    expect((await screen.findAllByText("Team AAA")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Team BBB").length).toBeGreaterThan(0);

    // Typing a team name matches on the (hidden) team keywords, not just the label.
    await user.type(screen.getByRole("combobox", { name: "Recipients" }), "Team AAA");
    expect(await screen.findByRole("option", { name: /Ann/, hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Ben/, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Cy/, hidden: true })).not.toBeInTheDocument();

    // Picking still leaves the closed-state pill showing the plain name only — the named
    // remove button (from accessibleRenderPill) carries just "Ann", no team text.
    await user.click(screen.getByRole("option", { name: /Ann/, hidden: true }));
    expect(screen.getByRole("button", { name: "Remove Ann" })).toBeInTheDocument();
  });

  test("a fifth pick is refused and the description says why until a pill is removed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: "Recipients" }));
    for (const name of ["Ann", "Ben", "Cy", "Di"]) {
      await user.click(await screen.findByRole("option", { name: new RegExp(name), hidden: true }));
    }
    expect(onChange).toHaveBeenLastCalledWith(["1", "2", "3", "4"]);

    // Mantine's maxValues leaves the remaining option listed and ignores the click — the
    // onMaxValues hook flips the description so the user learns why nothing happened.
    await user.click(await screen.findByRole("option", { name: /Ed/, hidden: true }));
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("combobox", { name: "Recipients" })).toHaveAccessibleDescription(
      "Maximum of 4 people reached — remove one to pick another",
    );

    await user.click(screen.getByRole("button", { name: "Remove Di" }));
    expect(onChange).toHaveBeenLastCalledWith(["1", "2", "3"]);
    expect(screen.getByRole("combobox", { name: "Recipients" })).toHaveAccessibleDescription("Up to 4 people");
  });
});
