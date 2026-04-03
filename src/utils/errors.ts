/**
 * Custom error classes for the checkout service.
 * Each error maps to an entry in SPEC.md §7 (Error Catalogue).
 *
 * Using typed errors means the Lambda handler can produce the correct
 * HTTP status code and error code without any string matching.
 */

import { ErrorCode } from '../types';

export class CheckoutError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
    // Restore prototype chain (required when extending built-ins in TypeScript)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400 — Request body fails schema or field validation. */
export class InvalidRequestError extends CheckoutError {
  constructor(message: string) {
    super('INVALID_REQUEST', 400, message);
    this.name = 'InvalidRequestError';
  }
}

/** 400 — Cart contains zero items. */
export class CartEmptyError extends CheckoutError {
  constructor() {
    super('CART_EMPTY', 400, 'The cart must contain at least one item.');
    this.name = 'CartEmptyError';
  }
}

/** 402 — Payment gateway declined or errored. */
export class PaymentFailedError extends CheckoutError {
  constructor(reason?: string) {
    super(
      'PAYMENT_FAILED',
      402,
      reason ?? 'Payment could not be captured. Please try a different payment method.',
    );
    this.name = 'PaymentFailedError';
  }
}

/** 409 — Concurrent write race condition (transient). */
export class OrderConflictError extends CheckoutError {
  constructor() {
    super('ORDER_CONFLICT', 409, 'An order for this cart is currently being processed.');
    this.name = 'OrderConflictError';
  }
}

/** 422 — Pricing invariant violated (e.g. negative total). */
export class PricingError extends CheckoutError {
  constructor(message?: string) {
    super(
      'PRICING_ERROR',
      422,
      message ?? 'Server could not calculate a valid total for this cart.',
    );
    this.name = 'PricingError';
  }
}

/** 500 — Catch-all for unexpected errors. */
export class InternalError extends CheckoutError {
  constructor() {
    super('INTERNAL_ERROR', 500, 'An unexpected error occurred. Please try again.');
    this.name = 'InternalError';
  }
}
