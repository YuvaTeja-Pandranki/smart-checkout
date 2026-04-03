/**
 * Server-side pricing calculation.
 * Implements the rules in SPEC.md §4 exactly.
 *
 * The client-supplied unitPrice is used as the catalogue price in this MVP
 * because there is no product database. The key invariant remains: the server
 * owns the total — it is never taken from a client-supplied `total` field.
 *
 * In production: replace the unitPrice source with a catalogue service lookup.
 */

import { CartItem, PricingBreakdown } from '../types';
import { PricingError } from '../utils/errors';

// SPEC.md §4.2 — Tax rate
const TAX_RATE = 0.10;

// SPEC.md §4.3 — Discount threshold and rate
const DISCOUNT_THRESHOLD = 100.00;
const DISCOUNT_RATE = 0.05;

// SPEC.md §4.5 — Maximum allowed total
const MAX_TOTAL = 999999.99;

/**
 * Round a number to exactly 2 decimal places.
 * Uses "round half away from zero" (standard financial rounding).
 */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Calculate the authoritative pricing breakdown for a cart.
 * @throws PricingError if any invariant in SPEC.md §4.5 is violated.
 */
export function calculatePricing(items: CartItem[]): PricingBreakdown {
  // §4.1 — Subtotal: each line rounded before summing
  const subtotal = round2(
    items.reduce((sum, item) => sum + round2(item.quantity * item.unitPrice), 0),
  );

  // §4.2 — Tax
  const tax = round2(subtotal * TAX_RATE);

  // §4.3 — Discount
  const discount = subtotal >= DISCOUNT_THRESHOLD ? round2(subtotal * DISCOUNT_RATE) : 0;

  // §4.4 — Total
  const total = round2(subtotal + tax - discount);

  // §4.5 — Invariants
  if (total <= 0) {
    throw new PricingError('Calculated total must be greater than zero.');
  }
  if (total > MAX_TOTAL) {
    throw new PricingError(`Calculated total ${total} exceeds the maximum allowed value of ${MAX_TOTAL}.`);
  }

  return { subtotal, tax, discount, total, currency: 'USD' };
}
