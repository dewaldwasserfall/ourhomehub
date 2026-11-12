/**
 * Calendar tab: the shared family calendar.
 *
 *   Agenda  today and the next 8 weeks, day by day (default)
 *   Month   a month grid with dots; tap a day to list its events
 *
 * Everything is read from the synced copy; adding, editing and deleting go
 * through the server to Google (see use-calendar.ts).
 */
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { EventSheet } from "@/components/event-sheet";
import { useHousehold } from "@/components/household-context";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, RefreshIcon, RepeatIcon } from "@/components/icons";
import { Navbar } from "@/components/navbar";
import { Segmented } from "@/components/segmented";
import { useToast } from "@/components/toast";
import { expandForRange, groupByDay } from "@/lib/calendar/expand";
import { addDays, dateKey, timeKey } from "@/lib/calendar/time";
import type { EventInput, Occurrence } from "@/lib/calendar/types";
import { useCalendar } from "@/lib/calendar/use-calendar";

type View = "agenda" | "month";
type SheetTarget = { kind: "new"; day: string } | { kind: "existing"; occurrence: Occurrence } | null;

const AGENDA_DAYS = 56;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "YYYY-MM-DD" -> a Date at noon UTC, safe for formatting the calendar day. */
const noon = (key: string) => new Date(`${key}T12:00:00Z`);
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
const weekdayName = fmt({ weekday: "long" });
const dayMonth = fmt({ day: "numeric", month: "long" });
const monthYear = fmt({ month: "long", year: "numeric" });

export default function CalendarPage() {
  const { household, me, memberByUserId, members } = useHousehold();
  const tz = household.timezone;
  const { rows, status, loading, syncing, sync, createEvent, updateEvent, deleteEvent } = useCalendar(household.id);
  const toast = useToast();

  const today = dateKey(new Date(), tz);
  const [view, setView] = useState<View>("agenda");
  const [month, setMonth] = useState(today.slice(0, 7)); // "YYYY-MM"
  const [selectedDay, setSelectedDay] = useState(today);
  const [sheet, setSheet] = useState<SheetTarget>(null);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const connected = Boolean(status);

  // ---------------------------------------------------------------------------
  // Step 1: occurrences for the agenda and for the visible month.
  // ---------------------------------------------------------------------------
  const agendaDays = useMemo(() => {
    const end = addDays(today, AGENDA_DAYS - 1);
    return groupByDay(expandForRange(rows, today, end, tz), today, end);
  }, [rows, today, tz]);

  const monthGrid = useMemo(() => {
    // Monday-start grid covering the whole month.
    const first = `${month}-01`;
    const weekdayOfFirst = (noon(first).getUTCDay() + 6) % 7;
    const gridStart = addDays(first, -weekdayOfFirst);
    const gridEnd = addDays(gridStart, 41);
    const byDay = groupByDay(expandForRange(rows, gridStart, gridEnd, tz), gridStart, gridEnd);
    const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
    // Drop a trailing week that's entirely next month.
    const trimmed = cells.slice(35).every((d) => !d.startsWith(month)) ? cells.slice(0, 35) : cells;
    return { cells: trimmed, byDay };
  }, [rows, month, tz]);

  // ---------------------------------------------------------------------------
  // Step 2: actions (errors come back as interface copy).
  // ---------------------------------------------------------------------------
  const onCreate = async (input: EventInput) => {
    const r = await createEvent(input);
    if (r.ok) toast.show("Added to the family calendar");
    return r.ok ? null : (r.message ?? "Couldn't add the event.");
  };
  const onUpdate = async (id: string, input: EventInput) => {
    const r = await updateEvent(id, input);
    if (r.ok) toast.show("Event updated");
    return r.ok ? null : (r.message ?? "Couldn't save the change.");
  };
  const onDelete = async (id: string) => {
    const r = await deleteEvent(id);
    if (r.ok) toast.show("Event deleted");
    return r.ok ? null : (r.message ?? "Couldn't delete the event.");
  };
  const onSync = async () => {
    const r = await sync();
    toast.show(r.ok ? "Up to date with Google Calendar" : (r.message ?? "Couldn't reach Google Calendar."));
  };

  // ---------------------------------------------------------------------------
  // Step 3: render helpers.
  // ---------------------------------------------------------------------------
  const dayLabel = (key: string) =>
    key === today ? "Today" : key === addDays(today, 1) ? "Tomorrow" : weekdayName.format(noon(key));

  const eventRow = (occ: Occurrence, day: string) => {
    const addedBy = occ.row.added_by_member ? memberById.get(occ.row.added_by_member) : undefined;
    const continues = occ.startDate < day;
    return (
      <button
        key={`${occ.key}:${day}`}
        type="button"
        className="row row--pressable event-row"
        onClick={() => setSheet({ kind: "existing", occurrence: occ })}
      >
        <span className="event-row__time">
          {occ.allDay ? (
            "All day"
          ) : continues ? (
            <span className="event-row__time-end">until {timeKey(occ.end!, tz)}</span>
          ) : (
            <>
              {timeKey(occ.start!, tz)}
              <span className="event-row__time-end">{timeKey(occ.end!, tz)}</span>
            </>
          )}
        </span>
        <span className={`event-row__bar ${occ.allDay ? "event-row__bar--allday" : ""}`} aria-hidden="true" />
        <span className="row__body">
          <span className="row__title">{occ.title || "(No title)"}</span>
          {(occ.row.location || occ.isRecurring) && (
            <span className="event-row__meta">
              {occ.isRecurring && <RepeatIcon size={13} aria-label="Repeats" />}
              {occ.row.location}
            </span>
          )}
        </span>
        {addedBy && addedBy.id !== me.id && (
          <span className="row__trailing">
            <Avatar member={addedBy} size="mini" />
          </span>
        )}
      </button>
    );
  };

  const navTrailing = connected ? (
    <>
      <button type="button" className="nav-button nav-button--icon" aria-label="Sync with Google Calendar" onClick={onSync} disabled={syncing}>
        <RefreshIcon size={21} style={syncing ? { animation: "spin 0.8s linear infinite" } : undefined} />
      </button>
      <button
        type="button"
        className="nav-button nav-button--icon"
        aria-label="New event"
        onClick={() => setSheet({ kind: "new", day: view === "month" ? selectedDay : today })}
      >
        <PlusIcon size={24} />
      </button>
    </>
  ) : undefined;

  // ---------------------------------------------------------------------------
  // Step 4: screens.
  // ---------------------------------------------------------------------------
  return (
    <main className="screen">
      <Navbar
        title="Calendar"
        trailing={navTrailing}
        subtitle={connected ? "Family calendar, synced with Google" : undefined}
      />

      {/* Loading */}
      {(loading || status === undefined) && (
        <section className="section">
          <div className="group" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 60 }} />
            ))}
          </div>
        </section>
      )}

      {/* Not connected yet */}
      {!loading && status === null && (
        <section className="section">
          <div className="group empty">
            <span className="empty__title">The family calendar isn&rsquo;t connected yet</span>
            {memberByUserId(me.user_id)?.role === "owner" ? (
              <>
                Connect it once on the Household tab and everyone will see it here.
                <div style={{ marginTop: 16 }}>
                  <Link href="/household" className="button button--primary">
                    Go to Household
                  </Link>
                </div>
              </>
            ) : (
              "Ask the household owner to connect it on the Household tab."
            )}
          </div>
        </section>
      )}

      {!loading && connected && (
        <>
          <section className="section">
            <Segmented
              label="Calendar view"
              value={view}
              onChange={setView}
              options={[
                { value: "agenda", label: "Agenda" },
                { value: "month", label: "Month" },
              ]}
            />
            {status?.status === "error" && (
              <p className="form-error" role="alert">
                Google stopped accepting the connection. The owner can reconnect it on the Household tab.
              </p>
            )}
          </section>

          {view === "agenda" && (
            <>
              {/* Today always shows, even when it's empty. */}
              {!agendaDays.has(today) && (
                <section className="section">
                  <div className="agenda-day agenda-day--today">
                    <span className="agenda-day__name">Today</span>
                    <span className="agenda-day__date">{dayMonth.format(noon(today))}</span>
                  </div>
                  <div className="group">
                    <div className="empty-day">Nothing planned</div>
                  </div>
                </section>
              )}
              {[...agendaDays.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([day, list]) => (
                  <section key={day} className="section">
                    <div className={`agenda-day ${day === today ? "agenda-day--today" : ""}`}>
                      <span className="agenda-day__name">{dayLabel(day)}</span>
                      <span className="agenda-day__date">{dayMonth.format(noon(day))}</span>
                    </div>
                    <div className="group">{list.map((occ) => eventRow(occ, day))}</div>
                  </section>
                ))}
              <p className="section__footer" style={{ marginTop: 24 }}>
                Showing the next 8 weeks. Switch to Month to look further ahead.
              </p>
            </>
          )}

          {view === "month" && (
            <>
              <section className="section">
                <div className="month">
                  <div className="month__bar">
                    <span className="month__title">{monthYear.format(noon(`${month}-01`))}</span>
                    <span className="month__nav">
                      <button
                        type="button"
                        className="nav-button nav-button--icon"
                        aria-label="Previous month"
                        onClick={() => setMonth(addDays(`${month}-01`, -1).slice(0, 7))}
                      >
                        <ChevronLeftIcon size={20} />
                      </button>
                      <button
                        type="button"
                        className="nav-button nav-button--icon"
                        aria-label="Next month"
                        onClick={() => setMonth(addDays(`${month}-01`, 32).slice(0, 7))}
                      >
                        <ChevronRightIcon size={20} />
                      </button>
                    </span>
                  </div>
                  <div className="month__grid">
                    {WEEKDAYS.map((d) => (
                      <span key={d} className="month__weekday">
                        {d}
                      </span>
                    ))}
                    {monthGrid.cells.map((day) => {
                      const count = monthGrid.byDay.get(day)?.length ?? 0;
                      const classes = [
                        "month__day",
                        !day.startsWith(month) && "month__day--outside",
                        day === today && "month__day--today",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <button
                          key={day}
                          type="button"
                          className={classes}
                          aria-pressed={day === selectedDay}
                          aria-label={`${weekdayName.format(noon(day))} ${dayMonth.format(noon(day))}, ${count} event${count === 1 ? "" : "s"}`}
                          onClick={() => setSelectedDay(day)}
                        >
                          <span className="month__day-num">{Number(day.slice(8))}</span>
                          {count > 0 && (
                            <span className="month__dots" aria-hidden="true">
                              {Array.from({ length: Math.min(count, 3) }, (_, i) => (
                                <span key={i} className="month__dot" />
                              ))}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              <section className="section">
                <div className={`agenda-day ${selectedDay === today ? "agenda-day--today" : ""}`}>
                  <span className="agenda-day__name">{dayLabel(selectedDay)}</span>
                  <span className="agenda-day__date">{dayMonth.format(noon(selectedDay))}</span>
                </div>
                <div className="group">
                  {(() => {
                    const list = groupByDay(expandForRange(rows, selectedDay, selectedDay, tz), selectedDay, selectedDay).get(selectedDay);
                    return list?.length ? (
                      list.map((occ) => eventRow(occ, selectedDay))
                    ) : (
                      <button
                        type="button"
                        className="row row--pressable"
                        style={{ color: "var(--accent)" }}
                        onClick={() => setSheet({ kind: "new", day: selectedDay })}
                      >
                        <PlusIcon size={20} />
                        <span className="row__body">Add an event on this day</span>
                      </button>
                    );
                  })()}
                </div>
              </section>
            </>
          )}
        </>
      )}

      <EventSheet
        target={sheet}
        timeZone={tz}
        onClose={() => setSheet(null)}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
      {toast.node}
    </main>
  );
}
