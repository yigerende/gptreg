'use strict';

/**
 * A clock for the Sentinel sandbox that lives in the account's time zone.
 *
 * The sandbox used to borrow the host's `Date` and `Intl`, which forced every
 * profile onto the machine running the console: a guard refused to start
 * unless the profile's zone equalled the host's. That made the zone a property
 * of the operator's laptop rather than of the account, and it is the one
 * fingerprint field an exit IP can be checked against directly — an American
 * address whose browser answers `Asia/Shanghai` has contradicted itself before
 * the page has finished loading.
 *
 * Everything here is a view over the same real instant. `Date.now()`, timers
 * and elapsed-time measurements are untouched; only the calendar fields, the
 * offset and the formatted strings move.
 */

const MINUTE_MS = 60_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(value, width = 2) {
  return String(Math.abs(value)).padStart(width, '0');
}

/**
 * The zone's offset at one instant, in minutes east of UTC.
 *
 * Read out of the zone's own formatted parts rather than from a table, so
 * daylight saving is handled by the same data the platform uses: an account on
 * `America/New_York` is -300 in January and -240 in July without this module
 * knowing either rule.
 */
function zoneOffsetMinutes(timeZone, instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const field = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'));
  // formatToParts drops sub-second precision, so compare on whole seconds.
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / MINUTE_MS);
}

function zoneAbbreviation(timeZone, instantMs, long = true) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: long ? 'long' : 'shortOffset',
  }).formatToParts(new Date(instantMs));
  return parts.find((part) => part.type === 'timeZoneName')?.value || '';
}

function offsetLabel(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `GMT${sign}${pad(Math.trunc(offsetMinutes / 60))}${pad(Math.abs(offsetMinutes % 60))}`;
}

/**
 * `Date` and `Intl` bound to one zone and locale.
 *
 * `Intl` is wrapped rather than replaced: the constructors default their
 * `timeZone` and locale to the profile's, so `resolvedOptions().timeZone`
 * reports the account's zone, and anything that passes its own options still
 * gets them.
 */
function createZonedTimeApis(options = {}) {
  const timeZone = String(options.timeZone || 'UTC');
  const locale = String(options.locale || 'en-US');
  // Fail here rather than deep inside the sandbox with an opaque stack.
  zoneOffsetMinutes(timeZone, Date.now());

  const offsetAt = (instantMs) => zoneOffsetMinutes(timeZone, instantMs);

  class ZonedDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super();
        return;
      }
      if (args.length === 1) {
        super(args[0] instanceof Date ? args[0].getTime() : args[0]);
        return;
      }
      // The multi-argument form reads its fields as local time, which here
      // means the profile's zone rather than the host's. Resolve the offset
      // twice: once for the naive instant, once for the corrected one, so a
      // construction that lands on a daylight-saving boundary settles.
      const [year, month, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = args.map(Number);
      const naive = Date.UTC(year, month, day, hour, minute, second, ms);
      const firstGuess = naive - offsetAt(naive) * MINUTE_MS;
      super(naive - offsetAt(firstGuess) * MINUTE_MS);
    }

    /** A plain Date whose UTC fields read as this instant's fields in the zone. */
    shifted() {
      return new Date(super.getTime() + offsetAt(super.getTime()) * MINUTE_MS);
    }

    fromShifted(shifted) {
      const naive = shifted.getTime();
      const firstGuess = naive - offsetAt(naive) * MINUTE_MS;
      super.setTime(naive - offsetAt(firstGuess) * MINUTE_MS);
      return super.getTime();
    }

    getTimezoneOffset() { return -offsetAt(super.getTime()); }

    getFullYear() { return this.shifted().getUTCFullYear(); }
    getMonth() { return this.shifted().getUTCMonth(); }
    getDate() { return this.shifted().getUTCDate(); }
    getDay() { return this.shifted().getUTCDay(); }
    getHours() { return this.shifted().getUTCHours(); }
    getMinutes() { return this.shifted().getUTCMinutes(); }
    getSeconds() { return this.shifted().getUTCSeconds(); }
    getMilliseconds() { return this.shifted().getUTCMilliseconds(); }
    getYear() { return this.getFullYear() - 1900; }

    setFullYear(...values) { const s = this.shifted(); s.setUTCFullYear(...values); return this.fromShifted(s); }
    setMonth(...values) { const s = this.shifted(); s.setUTCMonth(...values); return this.fromShifted(s); }
    setDate(...values) { const s = this.shifted(); s.setUTCDate(...values); return this.fromShifted(s); }
    setHours(...values) { const s = this.shifted(); s.setUTCHours(...values); return this.fromShifted(s); }
    setMinutes(...values) { const s = this.shifted(); s.setUTCMinutes(...values); return this.fromShifted(s); }
    setSeconds(...values) { const s = this.shifted(); s.setUTCSeconds(...values); return this.fromShifted(s); }
    setMilliseconds(...values) { const s = this.shifted(); s.setUTCMilliseconds(...values); return this.fromShifted(s); }

    toDateString() {
      const s = this.shifted();
      return `${WEEKDAYS[s.getUTCDay()]} ${MONTHS[s.getUTCMonth()]} ${pad(s.getUTCDate())} ${s.getUTCFullYear()}`;
    }

    toTimeString() {
      const instant = super.getTime();
      const s = this.shifted();
      const clock = `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}:${pad(s.getUTCSeconds())}`;
      return `${clock} ${offsetLabel(offsetAt(instant))} (${zoneAbbreviation(timeZone, instant)})`;
    }

    toString() {
      if (Number.isNaN(super.getTime())) return 'Invalid Date';
      return `${this.toDateString()} ${this.toTimeString()}`;
    }

    toLocaleString(locales, formatOptions) {
      return super.toLocaleString(locales || locale, { timeZone, ...(formatOptions || {}) });
    }

    toLocaleDateString(locales, formatOptions) {
      return super.toLocaleDateString(locales || locale, { timeZone, ...(formatOptions || {}) });
    }

    toLocaleTimeString(locales, formatOptions) {
      return super.toLocaleTimeString(locales || locale, { timeZone, ...(formatOptions || {}) });
    }
  }

  Object.defineProperty(ZonedDate, 'name', { value: 'Date' });

  function withZone(formatOptions) {
    return formatOptions && formatOptions.timeZone ? formatOptions : { ...(formatOptions || {}), timeZone };
  }

  // A plain function, not a class: `Intl.DateTimeFormat(...)` is legal without
  // `new`, and a class throws there. Returning the real formatter from both
  // call forms keeps `instanceof` and `supportedLocalesOf` working.
  function ZonedDateTimeFormat(locales, formatOptions) {
    return new Intl.DateTimeFormat(locales === undefined ? locale : locales, withZone(formatOptions));
  }
  ZonedDateTimeFormat.prototype = Intl.DateTimeFormat.prototype;
  ZonedDateTimeFormat.supportedLocalesOf = (...args) => Intl.DateTimeFormat.supportedLocalesOf(...args);
  Object.defineProperty(ZonedDateTimeFormat, 'name', { value: 'DateTimeFormat' });

  const zonedIntl = new Proxy(Intl, {
    get(target, property, receiver) {
      if (property === 'DateTimeFormat') return ZonedDateTimeFormat;
      return Reflect.get(target, property, receiver);
    },
  });

  return { Date: ZonedDate, Intl: zonedIntl, timeZone, locale, offsetMinutesAt: offsetAt };
}

module.exports = {
  createZonedTimeApis,
};
