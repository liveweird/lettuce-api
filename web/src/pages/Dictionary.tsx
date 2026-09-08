import type { ParseKeys } from "i18next";
import { useState } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Box,
  Button,
  Container,
  Group,
  Paper,
  Popover,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm, type FormErrors } from "@mantine/form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconPlus, IconListDetails } from "@tabler/icons-react";
import { isAdmin } from "../api/session";
import CenteredLoader from "../components/CenteredLoader";
import DiscardGuard from "../components/DiscardGuard";
import FormFooter from "../components/FormFooter";
import PageHeader from "../components/PageHeader";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../i18n";
import { getDictionary, updateDictionary, type DictionaryEntry, type DictionarySlug } from "../api/dictionaries";
import { showSuccessToast } from "../utils/toast";
import { useDiscardGuard } from "../hooks/useDiscardGuard";
import EmptyState from "../components/EmptyState";
import { RowControls } from "../components/ParagraphListEditor";
import {
  dictionaryFormValidation,
  errorLanguages,
  dictionarySaveErrorMessage,
  emptyEntryDraft,
  MAX_DICTIONARY_VALUE_LENGTH,
  toFormValues,
  toUpdateBody,
  type DictionaryFormValues,
} from "../utils/dictionaryForm";
import { charCountDescription } from "../utils/charCount";
import { pickLocalized } from "../utils/localized";
import { loadErrorMessage } from "../utils/saveError";

// The four global dictionaries — the slug is both the route param and the API path segment.
const DICTIONARIES: Record<DictionarySlug, { titleKey: ParseKeys }> = {
  "career-paths": { titleKey: "dictionary.title.careerPaths" },
  "career-specializations": { titleKey: "dictionary.title.careerSpecializations" },
  "seniority-levels": { titleKey: "dictionary.title.seniorityLevels" },
  "pulse-rotating-questions": { titleKey: "dictionary.title.pulseRotatingQuestions" },
};

const isDictionarySlug = (s: string | undefined): s is DictionarySlug =>
  s != null && s in DICTIONARIES;

/**
 * One page serves all four dictionaries (`/dictionaries/:slug`): everyone gets the ordered
 * read-only list; an ADMIN gets the whole-list document editor instead — add/edit/reorder/
 * remove rows locally, one Save replaces the dictionary atomically (the 1:1 editing idiom;
 * a removed entry is soft-deleted server-side).
 */
export default function Dictionary() {
  const { t } = useTranslation();
  const params = useParams<{ slug: string }>();
  const slug = isDictionarySlug(params.slug) ? params.slug : null;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["dictionary", slug],
    queryFn: () => getDictionary(slug as DictionarySlug),
    enabled: slug != null,
  });

  if (slug == null) return <Navigate to="/" replace />;

  // The Config-page shell (v3.5.2): PageHeader outside the container, the border-first Paper
  // inside. The guided tour anchors the nav leaf, not this title, so no tourId.
  return (
    <>
      <PageHeader title={t(DICTIONARIES[slug].titleKey)} mb="lg" />
      <Container size="md" px={0}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          {isError ? (
            <Alert color="red" variant="light" title={t("dictionary.loadFailed")}>
              {loadErrorMessage(error, t)}
            </Alert>
          ) : isLoading || !data ? (
            <CenteredLoader />
          ) : isAdmin() ? (
            // Keyed by slug: switching between the three nav leaves remounts the editor, so
            // each dictionary starts from its own freshly loaded document.
            <DictionaryEditor key={slug} slug={slug} initialItems={data} />
          ) : (
            <ReadOnlyEntries items={data} />
          )}
        </Paper>
      </Container>
    </>
  );
}

/**
 * The non-admin view: the ordered values as a compact numbered table (v3.4.0). The viewer's
 * language leads (with the English fallback); an entry holding more languages carries a count
 * badge that opens a popover listing the other filled translations — inline stacking stopped
 * scaling past two languages (v2.23.0), and the count keeps the list one line per entry at
 * any N; a single-language entry shows its count as plain text (nothing to unfold).
 */
function ReadOnlyEntries({ items }: { items: DictionaryEntry[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<IconListDetails size={32} stroke={1.2} color="var(--mantine-color-dimmed)" />}
        label={t("dictionary.empty")}
      />
    );
  }
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th style={{ width: 1 }}>{t("common.table.position")}</Table.Th>
          <Table.Th>{t("dictionary.column.value")}</Table.Th>
          <Table.Th style={{ width: 1, whiteSpace: "nowrap" }}>{t("dictionary.column.languages")}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((entry, index) => {
          // The viewer's language with the EN fallback (pickLocalized); the badge lists the
          // OTHER filled languages, so it needs to know which one is actually shown.
          const shown = pickLocalized(entry.values, lang);
          const shownLang = lang && shown === entry.values[lang] ? lang : "en";
          const others = SUPPORTED_LANGUAGES.filter(
            (l) => l !== shownLang && entry.values[l]?.trim(),
          );
          return (
            <Table.Tr key={entry.id}>
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                <Text size="sm" c="dimmed" ta="right">
                  {index + 1}.
                </Text>
              </Table.Td>
              {/* The fluid column (v3.4.0): takes the table's slack. */}
              <Table.Td style={{ width: "100%" }}>
                <Text size="sm">{shown}</Text>
              </Table.Td>
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                {others.length > 0 ? (
                  <EntryLanguagesBadge entry={entry} others={others} position={index + 1} />
                ) : (
                  <Text size="xs" c="dimmed">
                    {t("dictionary.translationCount", { count: 1 })}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

/** The per-entry language-count badge + the popover listing the other filled translations. */
function EntryLanguagesBadge({
  entry,
  others,
  position,
}: {
  entry: DictionaryEntry;
  others: SupportedLanguage[];
  position: number;
}) {
  const { t } = useTranslation();
  return (
    <Popover position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Badge
          component="button"
          type="button"
          variant="light"
          color="gray"
          size="sm"
          style={{ cursor: "pointer", flexShrink: 0 }}
          aria-label={t("dictionary.translationsAria", { position })}
        >
          {t("dictionary.translationCount", { count: others.length + 1 })}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={4}>
          {others.map((l) => (
            <Group key={l} gap="sm" wrap="nowrap" align="baseline">
              <Text size="xs" c="dimmed" w={90} style={{ flexShrink: 0 }}>
                {t(`common.languageName.${l}`)}
              </Text>
              <Text size="sm">{pickLocalized(entry.values, l)}</Text>
            </Group>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function DictionaryEditor({
  slug,
  initialItems,
}: {
  slug: DictionarySlug;
  initialItems: DictionaryEntry[];
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The save PUT committed but the re-seed GET failed (v2.24.0): the editor's rows lack their
  // minted ids, so a resubmit would INSERT DUPLICATES — freeze the editor and ask for a reload.
  const [staleAfterSave, setStaleAfterSave] = useState(false);

  // The editor always shows exactly two columns: English (required, canonical) beside ONE
  // translation language chosen by the picker below — constant width at any number of
  // supported languages (v2.23.0). Values typed into a currently hidden language live on in
  // the form state and ride the save regardless of what is visible.
  const translationLanguages = SUPPORTED_LANGUAGES.filter((l) => l !== "en");
  const [translationLang, setTranslationLang] = useState<SupportedLanguage>(
    translationLanguages[0] ?? "en",
  );
  const visibleLangs: SupportedLanguage[] =
    translationLanguages.length > 0 ? ["en", translationLang] : ["en"];

  const form = useForm<DictionaryFormValues>({
    initialValues: toFormValues(initialItems),
    validate: dictionaryFormValidation(t),
  });

  // Mantine's own form.isDirty() misses list operations — inserting/removing/reordering a row
  // never reliably flips its internal dirty flags (the EditGoal milestone-list precedent) — so
  // this compares the SAVE PAYLOAD instead of the raw form values (toUpdateBody strips the
  // React-list-identity `key` field, the only difference two loads would otherwise show).
  // Reused for the Save/Cancel disabled state too, not just the discard guard below.
  const dirty = () =>
    JSON.stringify(toUpdateBody(form.values)) !== JSON.stringify(toUpdateBody(toFormValues(initialItems)));

  // There is no separate list page to leave to — the editor and the read-only view share this
  // one route (v3.5.0's DiscardGuard is built for "leave to another screen"), so Cancel is a
  // same-page confirm. Its Discard button still performs a real react-router navigation (a
  // fresh `location.key`, even though the pathname is unchanged) — caught below to actually
  // revert the form, the guarded "adjust state while rendering" pattern (comparing against a
  // previous render's value; see react.dev's "storing information from previous renders").
  const { requestCancel, guardProps } = useDiscardGuard({
    isDirty: dirty,
    to: `/dictionaries/${slug}`,
    title: t("dictionary.discardTitle"),
    message: t("dictionary.discardMessage"),
  });
  const [lastLocationKey, setLastLocationKey] = useState(location.key);
  if (location.key !== lastLocationKey) {
    setLastLocationKey(location.key);
    if (guardProps.opened) {
      form.reset();
      setError(null);
      guardProps.onClose();
    }
  }

  // Languages currently holding a validation error (paths are `entries.<i>.values.<lang>`) —
  // they get a "•" marker in the picker, and a failed Save switches the visible column to the
  // first offending hidden language so its errors can actually be seen.
  const errorLangs = new Set(errorLanguages(Object.keys(form.errors)));

  function revealErrorLanguage(errors: FormErrors) {
    const hidden = errorLanguages(Object.keys(errors)).find(
      (lang) => lang !== "en" && lang !== translationLang,
    );
    if (hidden) setTranslationLang(hidden as SupportedLanguage);
  }

  async function save(values: DictionaryFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      await updateDictionary(slug, toUpdateBody(values));
    } catch (err) {
      setError(dictionarySaveErrorMessage(err, t));
      setSubmitting(false);
      return;
    }
    try {
      // Re-seed from the server so new rows carry their minted ids (a resubmit must rename,
      // not insert twice) and the saved state becomes the new dirty/reset baseline.
      const fresh = await getDictionary(slug);
      queryClient.setQueryData(["dictionary", slug], fresh);
      const freshValues = toFormValues(fresh);
      form.setInitialValues(freshValues);
      form.setValues(freshValues);
      form.resetDirty();
      showSuccessToast(t("dictionary.toast.saved"));
    } catch {
      // The PUT committed — this is NOT a save failure. Without the re-read the editor can't
      // be trusted for further edits, so it freezes behind the reload prompt below.
      setStaleAfterSave(true);
    } finally {
      setSubmitting(false);
    }
  }

  const rows = form.values.entries;

  return (
    <form onSubmit={form.onSubmit(save, revealErrorLanguage)} noValidate>
      <Stack>
        {translationLanguages.length > 0 && (
          <Select
            label={t("dictionary.translationLanguage")}
            value={translationLang}
            onChange={(value) => value && setTranslationLang(value as SupportedLanguage)}
            data={translationLanguages.map((lang) => ({
              value: lang,
              label: t(`common.languageName.${lang}`) + (errorLangs.has(lang) ? " •" : ""),
            }))}
            allowDeselect={false}
            w={220}
          />
        )}
        {rows.length === 0 && (
          <Text c="dimmed" size="sm">
            {t("dictionary.empty")}
          </Text>
        )}
        {rows.length > 0 && (
          // Column headers for the two visible inputs (the placeholders vanish once
          // filled). The row structure is mirrored — number gutter, English + the picked
          // translation column, and an invisible RowControls clone reserving exactly the
          // controls' width — so the labels stay aligned with the columns at any viewport.
          <Group align="flex-start" gap="xs" wrap="nowrap" mb={-8}>
            <Box w={24} style={{ flexShrink: 0 }} />
            <Group style={{ flex: 1 }} gap="xs" grow>
              {visibleLangs.map((lang) => (
                <Text key={lang} size="sm" fw={500}>
                  {t(`common.languageName.${lang}`)}
                  {lang !== "en" && (
                    <Text span size="xs" c="dimmed">
                      {" "}
                      {t("dictionary.optionalSuffix")}
                    </Text>
                  )}
                </Text>
              ))}
            </Group>
            <Box aria-hidden style={{ visibility: "hidden" }}>
              <RowControls
                index={0}
                count={1}
                onMoveUp={() => {}}
                onMoveDown={() => {}}
                onRemove={() => {}}
                moveUpLabel=""
                moveDownLabel=""
                removeLabel=""
              />
            </Box>
          </Group>
        )}
        {/* Hairline dividers between rows instead of a frame per row (v3.4.0). */}
        {rows.length > 0 && (
          <Stack gap={0}>
            {rows.map((row, index) => (
              <Box
                key={row.key}
                py="sm"
                style={
                  index < rows.length - 1
                    ? { borderBottom: "1px solid var(--mantine-color-default-border)" }
                    : undefined
                }
              >
                <Group align="flex-start" gap="xs" wrap="nowrap">
                  <Text size="sm" c="dimmed" w={24} ta="right" pt={8} style={{ flexShrink: 0 }}>
                    {index + 1}.
                  </Text>
                  {/* English beside the picked translation language: English is required, every
                      other language optional — a blank input means "no translation" and is
                      omitted from the save. Hidden languages keep their form values. */}
                  <Group style={{ flex: 1 }} gap="xs" align="flex-start" grow>
                    {visibleLangs.map((lang) => (
                      <TextInput
                        key={lang}
                        aria-label={t("dictionary.entryAria", {
                          position: index + 1,
                          language: t(`common.languageName.${lang}`),
                        })}
                        placeholder={t(`common.languageName.${lang}`)}
                        maxLength={MAX_DICTIONARY_VALUE_LENGTH}
                        description={charCountDescription(
                          form.values.entries[index]?.values[lang].length ?? 0,
                          MAX_DICTIONARY_VALUE_LENGTH,
                        )}
                        {...form.getInputProps(`entries.${index}.values.${lang}`)}
                      />
                    ))}
                  </Group>
                  <RowControls
                    index={index}
                    count={rows.length}
                    onMoveUp={() => form.reorderListItem("entries", { from: index, to: index - 1 })}
                    onMoveDown={() => form.reorderListItem("entries", { from: index, to: index + 1 })}
                    onRemove={() => form.removeListItem("entries", index)}
                    moveUpLabel={t("dictionary.moveUp", { position: index + 1 })}
                    moveDownLabel={t("dictionary.moveDown", { position: index + 1 })}
                    removeLabel={t("dictionary.removeEntry", { position: index + 1 })}
                  />
                </Group>
              </Box>
            ))}
          </Stack>
        )}
        <Group>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => form.insertListItem("entries", emptyEntryDraft())}
          >
            {t("dictionary.addEntry")}
          </Button>
        </Group>

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        {staleAfterSave && (
          <Alert color="orange" variant="light">
            <Group gap="sm" justify="space-between">
              <Text size="sm">{t("dictionary.savedButStale")}</Text>
              <Button size="xs" color="orange" variant="light" onClick={() => window.location.reload()}>
                {t("common.errorBoundary.reload")}
              </Button>
            </Group>
          </Alert>
        )}

        <FormFooter>
          {/* Unlike Save, Cancel is never gated on dirty (the shared discard-guard convention,
              EditAlert/EditGoal precedent) — requestCancel itself navigates straight away on a
              clean form and only prompts once there is something to lose. */}
          <Button
            type="button"
            variant="default"
            onClick={requestCancel}
            disabled={submitting || staleAfterSave}
          >
            {t("common.action.cancel")}
          </Button>
          <Button type="submit" loading={submitting} disabled={staleAfterSave || !dirty()}>
            {t("common.action.save")}
          </Button>
        </FormFooter>
      </Stack>

      <DiscardGuard {...guardProps} />
    </form>
  );
}
