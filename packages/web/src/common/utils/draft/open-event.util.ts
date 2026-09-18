import { type QueryClient } from "@tanstack/react-query";
import {
  editGridEventDraft,
  getGridDraftId,
} from "@web/events/grid-event-draft.adapter";
import { findEventInCache } from "@web/events/queries/event.query.cache";
import { draftActions, useDraftStore } from "@web/events/stores/draft.store";

/**
 * Opens a saved event's edit form directly, given only its id — the same
 * resolution `GridContextMenuWrapper.tsx`'s "Edit" item and right-click use,
 * extracted so a plain left-click (see `usePointerHintTracker.ts`) can do the
 * same thing instead of arming keyboard jump-mode. Returns false when the id
 * matches neither the live draft nor the cache, so the caller can no-op the
 * same way every other `findEventInCache` caller does.
 */
export function openSavedEventById(
  eventId: string,
  queryClient: QueryClient,
): boolean {
  const { gridDraft } = useDraftStore.getState();
  if (gridDraft && getGridDraftId(gridDraft) === eventId) {
    draftActions.setFormOpen(true);
    return true;
  }

  const sourceEvent = findEventInCache(queryClient, eventId);
  if (!sourceEvent) return false;

  const draft = editGridEventDraft(sourceEvent);
  if (!draft) return false;

  draftActions.startGridDraft({ activity: "gridClick", draft });
  return true;
}
