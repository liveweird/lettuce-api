import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAllTeamMembers } from "../api/teams";
import { userOption, type UserOption } from "../components/userOptions";
import { groupTeamRows } from "../utils/teamRows";

/**
 * The ONE cached reports pool behind every "pick a report" Select (goal / 1:1 /
 * review creates, the days-off on-behalf picker) — the useAllUsers sibling for
 * `view=managed`. Since v2.33.0 (the chain rule) it spans the caller's whole TRANSITIVE
 * subtree (`includeIndirect`), matching the widened create/record rights. Pre-audit each
 * screen ran its own copy of this query under a per-picker cache key (2026-08 audit round).
 *
 * ALL pages (the single-page-picker lesson): rows arrive one per (user, team), so a single
 * page of 100 truncates around ~50 reports across two teams; groupTeamRows dedupes to one
 * person, name-sorted here so every picker lists identically. Consumers surface
 * `reportsError` as the Select's `error` (the no-silent-blanks rule).
 */
export function useManagedReports(enabled: boolean): {
  reports: { userId: number; name: string; teamNames: string[] }[];
  reportsError: boolean;
  /** True once the pool actually loaded — the create screens resolve a preselected id
   *  against it and fall back to the picker only after this settles (v2.35.0). */
  reportsReady: boolean;
} {
  const { data, isError, isSuccess } = useQuery({
    queryKey: ["teamMembers", "managedReports", "indirect"],
    queryFn: () => listAllTeamMembers("managed", true),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
  const reports = useMemo(
    () =>
      groupTeamRows(data ?? [])
        .map((p) => ({ userId: p.userId, name: p.name, teamNames: p.teamNames }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );
  return { reports, reportsError: isError, reportsReady: isSuccess };
}

/** The pool as team-aware Mantine Select options — the shape all report-picker screens render. */
export function toReportOptions(
  reports: { userId: number; name: string; teamNames: string[] }[],
): UserOption[] {
  return reports.map((p) => userOption(p.userId, p.name, p.teamNames));
}
