import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { type PropsWithChildren } from "react";
import { type Calendar, getCalendarCapabilities } from "@core/types/calendar.contracts";
import { CalendarIdSchema, EventIdSchema } from "@core/types/domain-primitives";
import { calendarQueryKeys } from "@web/calendars/calendar.query";
import {
  DATA_TIMED_GRID_ROW,
  ID_GRID_COLUMNS_TIMED,
  ID_GRID_MAIN,
} from "@web/common/constants/web.constants";
import { createObjectIdString } from "@web/common/utils/id/object-id.util";
import {
  initialDraftState,
  selectGridDraft,
  useDraftStore,
} from "@web/events/stores/draft.store";
import {
  eventPointerActionAttributes,
  POINTER_ACTION_ATTRIBUTE,
  POINTER_ACTIONS,
  pointerPassAttributes,
  pointerShortcutAttributes,
} from "@web/shortcuts/keyboard-only/pointer-action";
import {
  resetPointerHintPersistenceForTests,
  writePointerHintDismissedPermanently,
} from "@web/shortcuts/keyboard-only/pointer-hint.storage";
import {
  initialPointerHintState,
  usePointerHintStore,
} from "@web/shortcuts/keyboard-only/pointer-hint.store";
import { usePointerHintTracker } from "@web/shortcuts/keyboard-only/usePointerHintTracker";
import {
  eventJumpActions,
  initialEventJumpState,
  useEventJumpStore,
} from "@web/shortcuts/shift-hint/event-jump.store";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

/** A single writable local calendar — enough for `usePointerHintTracker`'s
 * `useCalendarsQuery`/`useDefaultTargetCalendar`/`useConnectedAccounts` calls
 * to resolve a default target instead of racing a fetch. */
const writableCalendar: Calendar = {
  id: CalendarIdSchema.parse(createObjectIdString()),
  name: "Primary calendar",
  description: "",
  timeZone: null,
  foregroundColor: "#000000",
  backgroundColor: "#4285f4",
  provider: "local",
  access: "owner",
  capabilities: getCalendarCapabilities("owner"),
  isPrimary: true,
  isVisible: true,
  isActive: true,
};

const renderTracker = (enabled?: boolean) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(calendarQueryKeys.all, [writableCalendar]);
  function wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  }
  return renderHook(() => usePointerHintTracker(enabled), { wrapper });
};

const mounted: HTMLElement[] = [];
const mount = <T extends HTMLElement>(element: T): T => {
  document.body.appendChild(element);
  mounted.push(element);
  return element;
};

const press = (
  target: Element,
  init: Partial<PointerEventInit> = {},
): PointerEvent => {
  const event = new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    clientX: 100,
    clientY: 690,
    pointerType: "mouse",
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

const listenFor = (type: string): { count: () => number } => {
  let count = 0;
  const onEvent = () => {
    count += 1;
  };
  document.addEventListener(type, onEvent);
  listeners.push(() => document.removeEventListener(type, onEvent));
  return { count: () => count };
};
const listeners: Array<() => void> = [];

const pulseCount = () => usePointerHintStore.getState().pulse;
const latestAttempt = () => usePointerHintStore.getState().latestAttempt;

describe("usePointerHintTracker", () => {
  beforeEach(() => {
    resetPointerHintPersistenceForTests();
    usePointerHintStore.setState(initialPointerHintState, true);
    useEventJumpStore.setState(initialEventJumpState, true);
    useDraftStore.setState(initialDraftState, true);
  });

  afterEach(() => {
    for (const node of mounted) node.remove();
    mounted.length = 0;
    for (const off of listeners) off();
    listeners.length = 0;
    resetPointerHintPersistenceForTests();
    usePointerHintStore.setState(initialPointerHintState, true);
    useEventJumpStore.setState(initialEventJumpState, true);
    useDraftStore.setState(initialDraftState, true);
  });

  it("opens the clicked event directly instead of arming jump mode", () => {
    const eventId = EventIdSchema.parse(createObjectIdString());
    const card = mount(document.createElement("div"));
    card.setAttribute("role", "button");
    for (const [name, value] of Object.entries(
      eventPointerActionAttributes(eventId),
    )) {
      card.setAttribute(name, value);
    }
    const { unmount } = renderTracker();

    const event = press(card);

    expect(event.defaultPrevented).toBe(false);
    // The teaching pulse still fires — clicking still shows the shortcut for
    // next time, it just no longer needs it to actually open the event.
    expect(pulseCount()).toBe(1);
    expect(latestAttempt()).toEqual({
      actionId: POINTER_ACTIONS.eventOpen,
      eventId,
      performed: false,
    });
    // No cache entry for this id, so openSavedEventById no-ops — the point of
    // this test is that jump mode is never armed either way.
    expect(useEventJumpStore.getState().isActive).toBe(false);
    expect(useEventJumpStore.getState().pointerHintEventId).toBe(null);
    unmount();
  });

  it("tells a working button's shortcut for next time", () => {
    const button = mount(document.createElement("button"));
    for (const [name, value] of Object.entries(
      pointerShortcutAttributes("K"),
    )) {
      button.setAttribute(name, value);
    }
    const { unmount } = renderTracker();

    press(button);

    expect(latestAttempt()).toEqual({
      actionId: "unknown",
      shortcutKey: "K",
      performed: true,
    });
    unmount();
  });

  it("derives keys for an annotated working button without a shortcut", () => {
    const button = mount(document.createElement("button"));
    button.setAttribute(POINTER_ACTION_ATTRIBUTE, POINTER_ACTIONS.goToToday);
    const { unmount } = renderTracker();

    press(button);

    expect(latestAttempt()).toEqual({
      actionId: POINTER_ACTIONS.goToToday,
      shortcutKey: ["T"],
      performed: true,
    });
    unmount();
  });

  it("stays silent for working buttons with nothing to teach", () => {
    const button = mount(document.createElement("button"));
    const { unmount } = renderTracker();

    press(button);

    expect(pulseCount()).toBe(0);
    unmount();
  });

  it("stays silent on whitespace, inputs, and pass-through surfaces", () => {
    const whitespace = mount(document.createElement("div"));
    const input = mount(document.createElement("input"));
    const passRoot = mount(document.createElement("div"));
    for (const [name, value] of Object.entries(pointerPassAttributes)) {
      passRoot.setAttribute(name, value);
    }
    const passCard = document.createElement("div");
    passCard.setAttribute("role", "button");
    passRoot.appendChild(passCard);
    const { unmount } = renderTracker();

    press(whitespace);
    press(input);
    press(passCard);

    expect(pulseCount()).toBe(0);
    unmount();
  });

  it("gives an unannotated clickable-looking element the generic fallback", () => {
    const card = mount(document.createElement("div"));
    card.setAttribute("role", "button");
    const { unmount } = renderTracker();

    press(card);

    expect(latestAttempt()).toEqual({ actionId: "unknown", performed: false });
    unmount();
  });

  it("ignores right clicks and touch", () => {
    const card = mount(document.createElement("div"));
    card.setAttribute("role", "button");
    const { unmount } = renderTracker();

    press(card, { button: 2 });
    press(card, { pointerType: "touch" });

    expect(pulseCount()).toBe(0);
    unmount();
  });

  it("keeps opening the event directly after tips are turned off", () => {
    writePointerHintDismissedPermanently();
    const eventId = EventIdSchema.parse(createObjectIdString());
    const card = mount(document.createElement("div"));
    card.setAttribute("role", "button");
    for (const [name, value] of Object.entries(
      eventPointerActionAttributes(eventId),
    )) {
      card.setAttribute(name, value);
    }
    const { unmount } = renderTracker();

    press(card);

    expect(pulseCount()).toBe(0);
    expect(useEventJumpStore.getState().isActive).toBe(false);
    unmount();
  });

  it("creates and opens a timed draft on an empty timed-grid slot", () => {
    const grid = mount(document.createElement("div"));
    grid.id = ID_GRID_MAIN;
    Object.defineProperty(grid, "scrollHeight", { value: 1440 });
    grid.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 250, bottom: 400 }) as DOMRect;
    const columns = document.createElement("div");
    columns.id = ID_GRID_COLUMNS_TIMED;
    const column = document.createElement("div");
    column.dataset.gridDate = "2026-08-29";
    column.getBoundingClientRect = () =>
      ({ top: 0, left: 50, right: 250, bottom: 1440 }) as DOMRect;
    columns.appendChild(column);
    const hourRow = document.createElement("div");
    hourRow.setAttribute(DATA_TIMED_GRID_ROW, "true");
    grid.append(columns, hourRow);
    eventJumpActions.setActive(true);
    const { unmount } = renderTracker();

    press(hourRow);

    expect(latestAttempt()).toMatchObject({
      actionId: "grid.timed",
      gridDate: "2026-08-29",
      gridTimeKey: "1130",
      performed: false,
    });
    expect(useEventJumpStore.getState().isActive).toBe(false);
    const draft = selectGridDraft(useDraftStore.getState());
    expect(draft?.values.schedule.kind).toBe("timed");
    expect(draft?.values.calendarId).toBe(writableCalendar.id);
    expect(useDraftStore.getState().status?.activity).toBe("gridClick");
    expect(useDraftStore.getState().status?.isFormOpen).toBe(true);
    unmount();
  });

  it("does nothing while disabled", () => {
    const card = mount(document.createElement("div"));
    card.setAttribute("role", "button");
    const { unmount } = renderTracker(false);

    press(card);

    expect(pulseCount()).toBe(0);
    unmount();
  });
});
