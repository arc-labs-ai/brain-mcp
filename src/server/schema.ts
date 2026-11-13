/**
 * Argument types shared across tool families.
 *
 * A type lands here when more than one family needs it and getting it wrong
 * is a correctness problem rather than a style one — the bi-temporal instant
 * below being the case that motivated the file.
 */

import { z } from "zod";

/**
 * A unix-nanosecond instant, in a form an agent can actually produce.
 *
 * ## The bug this replaces
 *
 * These fields were `z.number().int()`. In zod 4 that means a SAFE integer, so
 * the emitted JSON Schema carried `maximum: 9007199254740991` and the
 * validator enforced it — and 2^53-1 nanoseconds past the epoch is **15 April
 * 1970**. Every real date is 100-200x over the cap, so every bi-temporal field
 * in this surface rejected every value it exists to receive:
 *
 *     Too big: expected int to be <=9007199254740991 at valid_from_unix_nanos
 *
 * The descriptions beside them cheerfully explained when to use them, which
 * made the failure more likely rather than less.
 *
 * ## What it accepts now
 *
 * An ISO-8601 instant FIRST, because that is the form a model gets right every
 * time; a bare number or a digit string are taken as nanoseconds for callers
 * that already hold one.
 *
 * ## Why a digit string is allowed at all
 *
 * A JSON number is a double. Nanosecond values above 2^53 are only exactly
 * representable when they have enough trailing zero bits — a whole second or
 * millisecond does, an arbitrary nanosecond does not. A string arrives
 * unrounded, so the check below can tell the two apart and REFUSE the lossy
 * one rather than storing a timestamp quietly off by a few hundred nanos.
 * (The wire field is a serde `u64` and takes a number, so the value is still
 * sent as one; the string only buys an honest precision check.)
 */
export const unixNanos = z
  .union([z.number(), z.string()])
  .transform((raw, ctx): number => {
    if (typeof raw === "number") {
      if (!Number.isInteger(raw) || raw < 0) {
        ctx.addIssue({
          code: "custom",
          message: "must be a non-negative whole number of nanoseconds",
        });
        return z.NEVER;
      }
      return raw;
    }
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      const value = Number(text);
      // The round trip is the test: a value a double cannot hold exactly comes
      // back as different digits.
      if (String(value) !== text && BigInt(text) !== BigInt(value)) {
        ctx.addIssue({
          code: "custom",
          message: `${text} cannot be represented exactly as a JSON number, so sending it would store a different instant. Round it to whole milliseconds (…000000) or pass an ISO-8601 time instead.`,
        });
        return z.NEVER;
      }
      return value;
    }
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) {
      ctx.addIssue({
        code: "custom",
        message:
          "expected an ISO-8601 instant like 2026-03-01T00:00:00Z, or a whole " +
          "number of unix nanoseconds",
      });
      return z.NEVER;
    }
    // Milliseconds to nanoseconds. Exact: the factor is 10^6, and the
    // product of any ms value in a plausible range stays inside a double's
    // exact-integer reach once its trailing zero bits are counted.
    return parsed * 1_000_000;
  });

/**
 * Opaque keyset cursor from a previous page's `next_cursor`.
 *
 * Brain's cursors are bound to the filters that produced them, so a caller
 * paging a filtered list must repeat every filter unchanged alongside the
 * cursor. Stated here because the cursor is where that bites.
 */
export const cursor = z
  .string()
  .min(1)
  .describe(
    "Opaque cursor from a previous page's `next_cursor`. Repeat the SAME " +
      "filters alongside it — a cursor is bound to the filters that made it.",
  );

/** Include records that have been tombstoned (soft-deleted). */
export const includeTombstoned = z
  .boolean()
  .describe("Include tombstoned (soft-deleted) records. Default false.");
