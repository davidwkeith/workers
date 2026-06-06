/**
 * XSD `dateTimeStamp` validation and canonicalization for VC date fields.
 *
 * VCDM 2.0 and the Data Integrity suites express temporal values — a
 * credential's `validFrom`/`validUntil` and a proof's `created` — as XSD
 * `dateTimeStamp` strings: an `xsd:dateTime` with a **mandatory** timezone
 * offset. vc-di-eddsa §3.3.5 step 3 requires erroring on an invalid `created`,
 * and a verifier must not silently treat a malformed `validUntil` as "no
 * expiry". These pure helpers gate both, so unparseable datetimes fail loudly
 * (at signing) or fail closed (at verification) rather than slipping through.
 *
 * @see https://www.w3.org/TR/xmlschema11-2/#dateTimeStamp
 */

// xsd:dateTimeStamp — an xsd:dateTime that REQUIRES an explicit timezone (`Z`
// or `±HH:MM`). Mirrors the W3C XML Schema 1.1 lexical space. The day-of-month
// upper bound (28–31) is checked separately against the actual month/year.
const XSD_DATE_TIME_STAMP =
  /^(-?(?:[1-9][0-9]{3,}|0[0-9]{3}))-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T(?:([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?|24:00:00(?:\.0+)?)(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Whether `value` is a valid XSD `dateTimeStamp`: a well-formed `xsd:dateTime`
 * carrying a mandatory timezone that also denotes a real calendar date (so
 * lexically-shaped-but-impossible dates like `2026-02-30` are rejected).
 */
export function isValidXsdDateTimeStamp(value: string): boolean {
  const match = XSD_DATE_TIME_STAMP.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return day <= daysInMonth(year, month);
}

/**
 * Canonicalize a date value to a second-precision XSD `dateTimeStamp`. A `Date`
 * is rendered in UTC (milliseconds dropped); a string is validated and passed
 * through unchanged. Throws when a string is not a valid XSD `dateTimeStamp`.
 */
export function toXsdDateTime(value: Date | string): string {
  if (typeof value === "string") {
    if (!isValidXsdDateTimeStamp(value)) {
      throw new Error(`@dwk/vc: "${value}" is not a valid XSD dateTimeStamp`);
    }
    return value;
  }
  // Drop milliseconds for the canonical, second-precision VC form.
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
