/* Working-day calendar helpers (Mon–Fri, UTC). Shared by the engine layers. */
(function (global) {
  const OEE = (global.OEE = global.OEE || {});

  function parse(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function iso(date) {
    return date.toISOString().slice(0, 10);
  }

  function isWorkday(date) {
    const dow = date.getUTCDay();
    return dow !== 0 && dow !== 6;
  }

  /* Advance n workdays from an ISO date (n=0 returns the same date,
   * normalized forward to a workday). */
  function addWorkdays(startIso, n) {
    const d = parse(startIso);
    while (!isWorkday(d)) d.setUTCDate(d.getUTCDate() + 1);
    let left = n;
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (isWorkday(d)) left -= 1;
    }
    return iso(d);
  }

  /* Workdays from a through b, inclusive on both ends. */
  function workdaysInclusive(aIso, bIso) {
    const a = parse(aIso);
    const b = parse(bIso);
    if (a > b) return -workdaysInclusive(bIso, aIso);
    let count = 0;
    const d = new Date(a);
    while (d <= b) {
      if (isWorkday(d)) count += 1;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return count;
  }

  /* The engine counts time in whole workdays from asOf: day 1 ends on asOf
   * itself. dayToDate maps "finished at end of day t" to a calendar date. */
  function dayToDate(asOfIso, t) {
    if (t <= 0) return asOfIso;
    return addWorkdays(asOfIso, t - 1);
  }

  OEE.calendar = { parse, iso, isWorkday, addWorkdays, workdaysInclusive, dayToDate };
})(typeof window !== 'undefined' ? window : globalThis);
