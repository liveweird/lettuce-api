// The app's ONE user-facing version, in its own tiny module so the shell (VersionStamp, the
// what's-new dot) doesn't drag the full bilingual changelog into the eager bundle — entries.ts
// (~170 KB) is a lazy dependency of the Changelog page only (2026-08 review round, CR-012).
// Releasing = adding the newest entry in entries.ts AND bumping this literal to its version;
// entries.test.ts pins the two together, so forgetting either fails the suite.
export const APP_VERSION = "3.8.4";
