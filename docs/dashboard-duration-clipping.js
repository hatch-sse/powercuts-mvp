function clippedDashboardDurationHours(event, startDate, endDateExclusive) {
  const firstSeen = new Date(event.first_seen);
  const lastSeen = new Date(event.last_seen);
  if (Number.isNaN(firstSeen.getTime()) || Number.isNaN(lastSeen.getTime())) return 0;
  const clippedStart = firstSeen > startDate ? firstSeen : startDate;
  const clippedEnd = lastSeen < endDateExclusive ? lastSeen : endDateExclusive;
  if (clippedEnd <= clippedStart) return 0;
  return (clippedEnd - clippedStart) / 36e5;
}

const originalAggregateEventsToSectorsForDurationClipping = aggregateEventsToSectors;
const originalSummariseEventsForDurationClipping = summariseEvents;

aggregateEventsToSectors = function aggregateEventsToSectorsWithClippedDurations(events) {
  const rows = originalAggregateEventsToSectorsForDurationClipping(events);
  const range = getDateRange();
  const clippedHoursBySector = new Map();

  for (const event of events) {
    const key = `${event.postcode_sector || ""}|${event.network || ""}`;
    clippedHoursBySector.set(
      key,
      (clippedHoursBySector.get(key) || 0) + clippedDashboardDurationHours(event, range.startDate, range.endDateExclusive)
    );
  }

  return rows.map((row) => {
    const key = `${row.postcode_sector || ""}|${row.network || ""}`;
    return {
      ...row,
      time_off_supply_hours_total_approx: Math.round((clippedHoursBySector.get(key) || 0) * 100) / 100,
    };
  });
};

summariseEvents = function summariseEventsWithClippedDurations(events) {
  const summary = originalSummariseEventsForDurationClipping(events);
  const range = getDateRange();
  const hours = events.reduce(
    (total, event) => total + clippedDashboardDurationHours(event, range.startDate, range.endDateExclusive),
    0
  );
  return { ...summary, hours: Math.round(hours * 100) / 100 };
};
