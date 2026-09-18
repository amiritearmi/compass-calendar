import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type CalendarId, CalendarIdSchema } from "@core/types/domain-primitives";
import dayjs from "@core/util/date/dayjs";
import { useCalendarsQuery } from "@web/calendars/calendar.query";
import { getWritableCalendars } from "@web/calendars/calendar.util";
import {
  useConnectedAccounts,
  useDefaultTargetCalendar,
} from "@web/calendars/useDefaultTargetCalendar";
import { track } from "@web/auth/posthog/track";
import {
  createAlldayDraft,
  startTimedDraftAt,
  timedDraftEnd,
} from "@web/common/utils/draft/draft.util";
import { openSavedEventById } from "@web/common/utils/draft/open-event.util";
import {
  type BlockedPointerAttempt,
  POINTER_PASS_ATTRIBUTE,
  pointerActionKeys,
  pointerGridIntentFromPointer,
  teachingFromBlockedPointer,
} from "@web/shortcuts/keyboard-only/pointer-action";
import { readPointerHintDismissedPermanently } from "@web/shortcuts/keyboard-only/pointer-hint.storage";
import { pointerHintActions } from "@web/shortcuts/keyboard-only/pointer-hint.store";
import { eventJumpActions } from "@web/shortcuts/shift-hint/event-jump.store";
import { viewFromPathname } from "@web/shortcuts/tips/shortcut-telemetry";
import { CALENDAR_COLUMN_ID_ATTRIBUTE } from "@web/views/Day/components/Calendar/dayCalendarColumnFocus.util";

const PRIMARY_BUTTON = 0;

const closestElement = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target : null;

const isEditableTarget = (element: Element): boolean =>
  element.closest(
    "input, textarea, select, [contenteditable='true'], [contenteditable='']",
  ) !== null;

const isPassTarget = (element: Element): boolean =>
  element.closest(`[${POINTER_PASS_ATTRIBUTE}]`) !== null;

/** Native controls run their own click handler; the hint only adds a tip. */
const isWorkingControl = (element: Element): boolean =>
  element.closest("button, a[href]") !== null;

type Teaching = {
  attempt: BlockedPointerAttempt;
  jumpEventId?: string;
  gridIntent?: ReturnType<typeof pointerGridIntentFromPointer>;
};

const resolveTeaching = (event: PointerEvent): Teaching | null => {
  const element = closestElement(event.target);
  if (!element) return null;
  if (isPassTarget(element) || isEditableTarget(element)) return null;

  const path = event.composedPath() as EventTarget[];
  const { attempt: base, jumpEventId } = teachingFromBlockedPointer(
    path,
    PRIMARY_BUTTON,
  );

  if (isWorkingControl(element)) {
    const keys = base.shortcutKey ?? pointerActionKeys(base.actionId);
    // A working control with nothing to teach stays silent.
    if (!keys) return null;
    return {
      attempt: {
        ...base,
        shortcutKey: typeof keys === "string" ? keys : [...keys],
        performed: true,
      },
    };
  }

  if (base.actionId === "unknown" && !base.shortcutKey) {
    const gridIntent = pointerGridIntentFromPointer(
      path,
      event.clientX,
      event.clientY,
    );
    if (gridIntent) {
      return {
        attempt: {
          actionId: gridIntent.kind === "timed" ? "grid.timed" : "grid.all-day",
          gridDate: gridIntent.date,
          gridTimeKey: gridIntent.timeKey,
          gridTimeLabel: gridIntent.timeLabel,
          performed: false,
        },
        gridIntent,
      };
    }
    // Whitespace is silent; something that looks clickable gets the
    // generic keyboard fallback.
    if (element.closest("[role='button']") === null) return null;
    return { attempt: { actionId: "unknown", performed: false } };
  }

  return { attempt: { ...base, performed: false }, jumpEventId };
};

const shortcutKeyLabel = (attempt: BlockedPointerAttempt): string => {
  if (attempt.shortcutKey) {
    return typeof attempt.shortcutKey === "string"
      ? attempt.shortcutKey
      : attempt.shortcutKey.join("+");
  }
  if (attempt.actionId === "grid.timed") return attempt.gridTimeKey ?? "";
  if (attempt.actionId === "grid.all-day") return "Shift+C";
  return "";
};

/** Everything the pointerdown listener needs that can change between renders
 * but is read from inside a `useEffect(..., [])` closure registered once. */
interface PointerActionLiveState {
  queryClient: QueryClient;
  defaultTargetCalendarId: CalendarId | null;
  writableCalendarIds: ReadonlySet<string>;
}

/** Day view stamps `data-calendar-column-id` on each calendar's column; Week
 * has no such attribute, so this naturally falls through to the default
 * target calendar there, matching `resolveShortcutCalendarId` in
 * `DayCalendarGrid.tsx` but resolved from the clicked element instead of
 * `document.activeElement`. */
const calendarIdForClickTarget = (
  target: Element | null,
  live: PointerActionLiveState,
): CalendarId | null => {
  const columnId = target
    ?.closest(`[${CALENDAR_COLUMN_ID_ATTRIBUTE}]`)
    ?.getAttribute(CALENDAR_COLUMN_ID_ATTRIBUTE);
  if (columnId && live.writableCalendarIds.has(columnId)) {
    const parsed = CalendarIdSchema.safeParse(columnId);
    if (parsed.success) return parsed.data;
  }
  return live.defaultTargetCalendarId;
};

/**
 * A click on a working control that carries a shortcut still performs the
 * action and shows the key for next time (teaching-only, unchanged). A click
 * on an event card or an empty grid slot no longer just teaches the shortcut:
 * it opens the event or creates a draft directly, via the same functions the
 * right-click menu and the "C" / "Shift+C" / Enter keyboard paths already
 * call (see `open-event.util.ts`, `draft.util.ts`) — the taught key still
 * shows so keyboard use stays discoverable. Text selection and copy buttons
 * are untouched. Mounted once in RootShell for calendar views.
 */
export function usePointerHintTracker(enabled = true) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const queryClient = useQueryClient();
  const { data: calendars = [] } = useCalendarsQuery();
  const defaultTargetCalendarId = useDefaultTargetCalendar(calendars)?.id ?? null;
  const connectedAccounts = useConnectedAccounts();
  const liveRef = useRef<PointerActionLiveState>({
    queryClient,
    defaultTargetCalendarId,
    writableCalendarIds: new Set(),
  });
  liveRef.current = {
    queryClient,
    defaultTargetCalendarId,
    writableCalendarIds: new Set(
      getWritableCalendars(calendars, {
        hasConnectedAccount: connectedAccounts.length > 0,
      }).map((calendar) => calendar.id),
    ),
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!enabledRef.current) return;
      if (event.button !== PRIMARY_BUTTON || event.pointerType === "touch") {
        return;
      }

      const teaching = resolveTeaching(event);
      if (!teaching) return;
      const { attempt, gridIntent, jumpEventId } = teaching;

      if (!readPointerHintDismissedPermanently()) {
        pointerHintActions.pulse(attempt);
        track("pointer_hint_shown", {
          action_id: attempt.actionId,
          shortcut_key: shortcutKeyLabel(attempt),
          performed: attempt.performed === true,
          view: viewFromPathname(window.location.pathname),
        });
      }

      // A click now performs the action directly instead of arming a
      // keyboard shortcut for it — see open-event.util.ts and draft.util.ts
      // for the same direct-action functions the right-click menu and "C" /
      // "Shift+C" keyboard shortcuts already use.
      if (gridIntent) {
        eventJumpActions.setActive(false);
        const calendarId = calendarIdForClickTarget(
          closestElement(event.target),
          liveRef.current,
        );
        if (gridIntent.kind === "all-day") {
          createAlldayDraft(dayjs(gridIntent.date), "gridClick", calendarId);
        } else if (gridIntent.start) {
          const start = dayjs(gridIntent.start);
          startTimedDraftAt(
            start.format(),
            timedDraftEnd(start).format(),
            "gridClick",
            calendarId,
          );
        }
        return;
      }
      if (jumpEventId) {
        eventJumpActions.setActive(false);
        openSavedEventById(jumpEventId, liveRef.current.queryClient);
        return;
      }
      // Jump mode swallows unmatched printable keys, including `]`.
      eventJumpActions.setActive(false);
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
}
