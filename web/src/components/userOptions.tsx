import { Stack, Text } from "@mantine/core";

// The shared option shape for every "pick a person" Select/MultiSelect: the LABEL stays the
// plain name (Mantine mirrors it into the closed input value and every MultiSelect chip — a
// team suffix there would bloat both, see userOption below), while `teamNames` feeds the
// dimmed subtitle renderUserOption draws in the dropdown and `keywords` feeds the theme-wide
// foldedOptionsFilter (utils/text.ts) so typing a team name also matches. Both stay OPTIONAL
// (the renderPeriodOption/ReviewPeriodOption precedent, useReviewPeriodOptions.tsx) — Mantine's
// `renderOption` prop is typed over the bare `ComboboxItem<string>` regardless of what `data`
// actually holds, so a required extra field would fail assignability at every call site.
export type UserOption = {
  value: string;
  label: string;
  teamNames?: string[];
  keywords?: string;
};

/** Builds a team-aware person option — the ONE builder every picker's option list uses. */
export function userOption(id: number, name: string, teamNames: string[]): UserOption {
  return { value: String(id), label: name, teamNames, keywords: teamNames.join(" ") };
}

// The shared person-picker renderOption (modelled on PeriodOptionLabel in
// useReviewPeriodOptions.tsx): the name always, and — only when the person belongs to at least
// one team — a dimmed second line of team names joined by " · ". Deliberately NOT part of the
// label text: see the UserOption doc comment above. Tolerates options built without teamNames
// (renders just the name), the same forgiving contract as renderPeriodOption.
export function renderUserOption({ option }: { option: UserOption }) {
  const teamNames = option.teamNames ?? [];
  return (
    <Stack gap={0}>
      <Text size="sm">{option.label}</Text>
      {teamNames.length > 0 && (
        <Text size="xs" c="dimmed">
          {teamNames.join(" · ")}
        </Text>
      )}
    </Stack>
  );
}
