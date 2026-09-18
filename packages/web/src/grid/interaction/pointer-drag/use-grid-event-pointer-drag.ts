import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { YEAR_MONTH_DAY_FORMAT } from "@core/constants/date.constants";
import dayjs, { type Dayjs } from "@core/util/date/dayjs";
import { ID_GRID_ALLDAY_ROW } from "@web/common/constants/web.constants";
import { type GridEventDraft } from "@web/events/event-draft.types";
import {
  allDayGridSchedule,
  editGridEventDraft,
  gridEventDraftToGridEvent,
  replaceGridDraftSchedule,
  timedGridSchedule,
} from "@web/events/grid-event-draft.adapter";
import { useUpdateEvent } from "@web/events/mutations/useUpdateEvent";
import { findEventInCache } from "@web/events/queries/event.query.cache";
import {
  draftActions,
  selectGridDraft,
  useDraftStore,
} from "@web/events/stores/draft.store";
import { GRID_TIME_STEP } from "@web/grid/grid.constants";
import {
  type CalendarGridView,
  calendarViewInteraction,
} from "@web/grid/interaction/view-event-registry";
import {
  gridDateFromColumns,
  snappedGridMinuteAtY,
} from "@web/shortcuts/keyboard-only/pointer-action";
import { getEffectiveTimeZone } from "@web/timezone/effective-timezone.store";

const PRIMARY_BUTTON = 0;

/** Below this, a mousedown-then-up on an event card is a click (handled
 * separately, opening it); at or beyond it, the pointer is dragging the
 * card. Matches the pre-#2830 drag engine's tuned value for this gesture. */
const POINTER_DRAG_MOVE_THRESHOLD_PX = 25;

/** A pointerdown within this many pixels of a card's edge resizes that edge
 * instead of moving the whole card. */
const RESIZE_EDGE_HIT_PX = 8;

/** Duration invented when a drag carries an all-day event down into the
 * timed grid — an all-day span has no time-of-day and no meaningful length
 * in minutes, so this makes one up. An hour is the least surprising block to
 * hand back, and trivial for the user to resize afterward. */
const CROSS_ROW_TIMED_DURATION_MIN = 60;

type DragMode = "move" | "resize-start" | "resize-end";

interface DragSession {
  readonly mode: DragMode;
  readonly eventType: "all-day" | "timed";
  readonly anchorClientX: number;
  readonly anchorClientY: number;
  /** The day (YYYY-MM-DD) the drag started on — the reference point every
   * subsequent move re-resolves its day/time delta against, rather than
   * accumulating deltas move-to-move (which would drift). */
  readonly anchorDay: string;
  readonly originalStart: Date;
  readonly originalEnd: Date;
  /** Resolved once on pointerdown; only actually seeded into the draft store
   * once the movement threshold is crossed (see `onMove`) — seeding it
   * immediately would race `usePointerHintTracker`'s click-to-open handler,
   * which runs on this same pointerdown and opens the form; this hook would
   * then immediately stomp that with `openForm: false`. */
  readonly draft: GridEventDraft;
}

const isPrimaryPointer = (event: PointerEvent): boolean =>
  event.button === PRIMARY_BUTTON && event.pointerType !== "touch";

const resolveTimedDragMode = (rect: DOMRect, clientY: number): DragMode => {
  if (clientY - rect.top <= RESIZE_EDGE_HIT_PX) return "resize-start";
  if (rect.bottom - clientY <= RESIZE_EDGE_HIT_PX) return "resize-end";
  return "move";
};

const resolveAllDayDragMode = (rect: DOMRect, clientX: number): DragMode => {
  if (clientX - rect.left <= RESIZE_EDGE_HIT_PX) return "resize-start";
  if (rect.right - clientX <= RESIZE_EDGE_HIT_PX) return "resize-end";
  return "move";
};

const isWithinAllDayRow = (clientY: number): boolean => {
  const row = document.getElementById(ID_GRID_ALLDAY_ROW);
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  return clientY >= rect.top && clientY <= rect.bottom;
};

/** Whichever of the resize anchor or the dragged instant is earlier becomes
 * the start — same "drag either direction" semantics as phase 2's
 * drag-to-create, so dragging a resize handle past the opposite edge flips
 * which edge is "start" instead of producing a negative span. */
const resizeTimed = (
  anchor: Dayjs,
  dragged: Dayjs,
): { start: Date; end: Date } => {
  const [a, b] = dragged.isBefore(anchor) ? [dragged, anchor] : [anchor, dragged];
  const end = b.isAfter(a) ? b : a.add(GRID_TIME_STEP, "minute");
  return { start: a.toDate(), end: end.toDate() };
};

/** All-day mirror of `resizeTimed` — `anchor`/`dragged` are inclusive days;
 * the stored schedule's `end` is exclusive (the day after the last
 * inclusive day), matching `createAlldayDraft`'s convention. */
const resizeAllDay = (
  anchor: Dayjs,
  dragged: Dayjs,
): { start: Date; end: Date } => {
  const [a, b] = dragged.isBefore(anchor) ? [dragged, anchor] : [anchor, dragged];
  return { start: a.toDate(), end: b.add(1, "day").toDate() };
};

const applyDragMove = (session: DragSession, moveEvent: PointerEvent): void => {
  const current = selectGridDraft(useDraftStore.getState());
  if (!current) return;

  const nowInAllDayRow = isWithinAllDayRow(moveEvent.clientY);

  // Cross-row: the drag carried the card into the other row.
  if (session.eventType === "timed" && nowInAllDayRow) {
    const day = gridDateFromColumns("all-day", moveEvent.clientX) ?? session.anchorDay;
    draftActions.setGridDraft(
      replaceGridDraftSchedule(
        current,
        allDayGridSchedule(day, dayjs(day).add(1, "day").format(YEAR_MONTH_DAY_FORMAT)),
      ),
    );
    return;
  }
  if (session.eventType === "all-day" && !nowInAllDayRow) {
    const day = gridDateFromColumns("timed", moveEvent.clientX) ?? session.anchorDay;
    const snapped = snappedGridMinuteAtY(moveEvent.clientY);
    if (!snapped) return;
    const hh = String(snapped.hour).padStart(2, "0");
    const mm = String(snapped.minutes).padStart(2, "0");
    const start = dayjs.tz(`${day}T${hh}:${mm}`, getEffectiveTimeZone());
    draftActions.setGridDraft(
      replaceGridDraftSchedule(
        current,
        timedGridSchedule(
          start.toDate(),
          start.add(CROSS_ROW_TIMED_DURATION_MIN, "minute").toDate(),
        ),
      ),
    );
    return;
  }

  // Same row the drag started in.
  if (session.eventType === "all-day") {
    const day = gridDateFromColumns("all-day", moveEvent.clientX) ?? session.anchorDay;
    const draggedDay = dayjs(day);
    const originalStart = dayjs(session.originalStart);
    const lastInclusiveDay = dayjs(session.originalEnd).subtract(1, "day");

    if (session.mode === "move") {
      const dayDiff = draggedDay.diff(dayjs(session.anchorDay), "day");
      draftActions.setGridDraft(
        replaceGridDraftSchedule(current, {
          kind: "allDay",
          start: originalStart.add(dayDiff, "day").toDate(),
          end: dayjs(session.originalEnd).add(dayDiff, "day").toDate(),
        }),
      );
      return;
    }
    const anchor = session.mode === "resize-start" ? lastInclusiveDay : originalStart;
    const { start, end } = resizeAllDay(anchor, draggedDay);
    draftActions.setGridDraft(
      replaceGridDraftSchedule(current, { kind: "allDay", start, end }),
    );
    return;
  }

  // Timed, same row.
  const day = gridDateFromColumns("timed", moveEvent.clientX) ?? session.anchorDay;
  const snapped = snappedGridMinuteAtY(moveEvent.clientY);
  if (!snapped) return;
  const hh = String(snapped.hour).padStart(2, "0");
  const mm = String(snapped.minutes).padStart(2, "0");
  const draggedInstant = dayjs.tz(`${day}T${hh}:${mm}`, getEffectiveTimeZone());

  if (session.mode === "move") {
    const dayDiff = dayjs(day).diff(dayjs(session.anchorDay), "day");
    const anchorMinutes = (() => {
      const anchorSnap = snappedGridMinuteAtY(session.anchorClientY);
      return anchorSnap ? anchorSnap.hour * 60 + anchorSnap.minutes : null;
    })();
    if (anchorMinutes === null) return;
    const currentMinutes = snapped.hour * 60 + snapped.minutes;
    const minuteDiff = currentMinutes - anchorMinutes;
    draftActions.setGridDraft(
      replaceGridDraftSchedule(
        current,
        timedGridSchedule(
          dayjs(session.originalStart).add(dayDiff, "day").add(minuteDiff, "minute").toDate(),
          dayjs(session.originalEnd).add(dayDiff, "day").add(minuteDiff, "minute").toDate(),
        ),
      ),
    );
    return;
  }
  const anchor =
    session.mode === "resize-start"
      ? dayjs(session.originalEnd)
      : dayjs(session.originalStart);
  const { start, end } = resizeTimed(anchor, draggedInstant);
  draftActions.setGridDraft(
    replaceGridDraftSchedule(current, timedGridSchedule(start, end)),
  );
};

/**
 * Drag an existing timed or all-day event to move it (day and/or time) or
 * resize one edge, including crossing between the timed grid and the
 * all-day row. A single delegated `pointerdown` on the grid container
 * (mirroring `usePointerHintTracker`'s style) resolves the target through
 * the same registry the keyboard shortcuts use
 * (`calendarViewInteraction(view).registry`) — read-only, busy, and
 * provider-managed cards never register (`use-grid-event-card-interaction.ts`),
 * so they're never a drag target here, for free.
 *
 * Below the movement threshold at release, nothing happens: the click has
 * already been handled by `usePointerHintTracker`'s direct-open on the same
 * pointerdown. Only Week view is wired today — Day view's per-column
 * calendar (dragging an event onto a different calendar's column) is not
 * yet supported.
 */
export function useGridEventPointerDrag({
  view,
}: {
  view: CalendarGridView;
}): void {
  const queryClient = useQueryClient();
  const updateEvent = useUpdateEvent();
  const liveRef = useRef({ queryClient, updateEvent });
  liveRef.current = { queryClient, updateEvent };

  useEffect(() => {
    let session: DragSession | null = null;
    let seeded = false;

    const onMove = (moveEvent: PointerEvent) => {
      if (!session) return;
      if (!seeded) {
        const distance = Math.hypot(
          moveEvent.clientX - session.anchorClientX,
          moveEvent.clientY - session.anchorClientY,
        );
        if (distance < POINTER_DRAG_MOVE_THRESHOLD_PX) return;
        seeded = true;
        // Only now does the matching saved card become a dimmed placeholder
        // (`use-grid-event-card-interaction.ts`) and a live ghost start
        // rendering — a plain click never reaches here, so it never
        // disturbs `usePointerHintTracker`'s direct-open on the same
        // pointerdown.
        draftActions.startGridDraft({
          activity: "pointerDrag",
          draft: session.draft,
          openForm: false,
        });
      }
      applyDragMove(session, moveEvent);
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (seeded) {
        if (commit) {
          const draft = selectGridDraft(useDraftStore.getState());
          if (draft) {
            liveRef.current.updateEvent(
              { event: gridEventDraftToGridEvent(draft) },
              true,
              { onOptimisticApplied: () => draftActions.discard() },
            );
          }
        } else {
          draftActions.discard();
        }
      }
      session = null;
      seeded = false;
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    const onPointerDown = (downEvent: PointerEvent) => {
      if (!isPrimaryPointer(downEvent)) return;
      const resolved = calendarViewInteraction(view).registry.resolveFromTarget(
        downEvent.target,
      );
      if (!resolved) return;

      const sourceEvent = findEventInCache(
        liveRef.current.queryClient,
        resolved.eventId,
      );
      if (!sourceEvent) return;
      const draft = editGridEventDraft(sourceEvent);
      if (!draft || draft.kind !== "edit") return;

      const rect = resolved.element.getBoundingClientRect();
      const mode: DragMode =
        resolved.eventType === "all-day"
          ? resolveAllDayDragMode(rect, downEvent.clientX)
          : resolveTimedDragMode(rect, downEvent.clientY);

      const { schedule } = draft.values;
      session = {
        mode,
        eventType: resolved.eventType,
        anchorClientX: downEvent.clientX,
        anchorClientY: downEvent.clientY,
        anchorDay: dayjs(schedule.start).format(YEAR_MONTH_DAY_FORMAT),
        originalStart: schedule.start,
        originalEnd: schedule.end,
        draft,
      };
      seeded = false;

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [view]);
}
