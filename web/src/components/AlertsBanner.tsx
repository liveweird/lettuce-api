import { useEffect, useState } from "react";
import { ActionIcon, Alert, Box, Group, Portal, Text } from "@mantine/core";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconSpeakerphone,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ALERTS_BAR_HEIGHT, useVisibleAlerts } from "../hooks/useVisibleAlerts";
import MarkdownView from "./MarkdownView";
import classes from "./AlertsBanner.module.css";

const STORAGE_KEY = "lettuce.alertsBanner";

type BannerState = { hidden: boolean; seenMaxId: number };

function readState(): BannerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BannerState>;
      return { hidden: parsed.hidden === true, seenMaxId: Number(parsed.seenMaxId) || 0 };
    }
  } catch {
    // Storage unavailable/corrupt — fall through to the default (banner shown).
  }
  return { hidden: false, seenMaxId: 0 };
}

function writeState(state: BannerState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence only.
  }
}

/**
 * The app-wide announcement banner, rendered as the first row of AppShell.Header. While any
 * alerts are visible (server-decided, refetched every minute) a slim orange-tinted strip occupies
 * a permanent row above the header — the only layout impact, and only when alerts appear/expire.
 * Expanding renders the full banner as a fixed overlay that temporarily covers the strip and
 * the header, so hiding/showing never reflows the page. The user can hide/show — never close.
 * Hidden state persists in localStorage, but a new alert (an unseen id) auto-expands it.
 */
export default function AlertsBanner() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(() => readState().hidden);
  const [index, setIndex] = useState(0);

  const { data } = useVisibleAlerts();

  const items = data ?? [];
  const maxId = items.reduce((acc, a) => Math.max(acc, a.id), 0);

  // Auto-unhide when an alert id we have never seen appears; remember it either way.
  useEffect(() => {
    if (maxId === 0) return;
    const stored = readState();
    if (maxId > stored.seenMaxId) {
      writeState({ hidden: false, seenMaxId: maxId });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs local hidden state to a new unseen alert id discovered from localStorage, not derivable during render
      setHidden(false);
    }
  }, [maxId]);

  // The banner must never break the app: nothing to show (or a failed fetch) renders nothing.
  if (items.length === 0) return null;

  function toggleHidden(next: boolean) {
    setHidden(next);
    writeState({ hidden: next, seenMaxId: maxId });
  }

  // The visible set can shrink between refetches; clamp instead of indexing past the end.
  const current = items[Math.min(index, items.length - 1)];

  return (
    <>
      {/* The permanent strip. When expanded it is fully covered by the overlay below, so it
          renders as an empty spacer (aria-hidden) — screen readers hear one state, not both. */}
      <Box h={ALERTS_BAR_HEIGHT} px="md" className={classes.strip} aria-hidden={!hidden || undefined}>
        {hidden && (
          <Group gap="xs" wrap="nowrap" h="100%">
            <IconSpeakerphone size={16} />
            <Text size="sm" fw={500} style={{ flex: 1 }}>
              {t("alerts.banner.hiddenCount", { count: items.length })}
            </Text>
            <ActionIcon
              variant="transparent"
              color="orange"
              size="sm"
              aria-label={t("alerts.banner.show")}
              onClick={() => toggleHidden(false)}
            >
              <IconChevronDown size={16} />
            </ActionIcon>
          </Group>
        )}
      </Box>

      {!hidden && (
        <Portal>
          {/* Fixed overlay covering the strip + header until hidden again — toggling the
              banner therefore never shifts the page. z-index sits above the AppShell (100)
              and below Mantine modals (200). */}
          <Box style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 150 }}>
            {/* The light orange surface + Mantine's scheme-aware orange ink (AA in both schemes,
                guarded by theme.test.ts); the strong left rule is the prominence cue. Never
                `variant="filled"` + autoContrast here: under primaryShade 7 Mantine judged
                orange-7 "dark" and painted white on it (3.0:1). */}
            <Alert
              color="orange"
              variant="light"
              icon={<IconSpeakerphone size={20} />}
              radius={0}
              classNames={{ root: classes.banner }}
              styles={{ body: { minWidth: 0 } }}
            >
              <Group gap="xs" wrap="nowrap" align="flex-start">
                {/* Inverted chip (the banner ink as the fill, the body colour as the text) so
                    the title stays visually senior to any markdown heading in the content
                    without competing on font size. */}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text component="span" fw={700} size="sm" px={10} py={3} className={classes.titleChip}>
                    {current.title}
                  </Text>
                </Box>
                {items.length > 1 && (
                  <Group gap={4} wrap="nowrap">
                    <ActionIcon
                      variant="transparent"
                      color="orange"
                      size="sm"
                      className={classes.pagerButton}
                      disabled={index <= 0}
                      aria-label={t("alerts.banner.previous")}
                      onClick={() => setIndex((i) => Math.max(0, i - 1))}
                    >
                      <IconChevronLeft size={16} />
                    </ActionIcon>
                    <Text size="sm">
                      {t("alerts.banner.counter", {
                        current: Math.min(index, items.length - 1) + 1,
                        total: items.length,
                      })}
                    </Text>
                    <ActionIcon
                      variant="transparent"
                      color="orange"
                      size="sm"
                      className={classes.pagerButton}
                      disabled={index >= items.length - 1}
                      aria-label={t("alerts.banner.next")}
                      onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
                    >
                      <IconChevronRight size={16} />
                    </ActionIcon>
                  </Group>
                )}
                <ActionIcon
                  variant="transparent"
                  color="orange"
                  size="sm"
                  aria-label={t("alerts.banner.hide")}
                  onClick={() => toggleHidden(true)}
                >
                  <IconChevronUp size={16} />
                </ActionIcon>
              </Group>
              <MarkdownView>{current.content}</MarkdownView>
            </Alert>
          </Box>
        </Portal>
      )}
    </>
  );
}
