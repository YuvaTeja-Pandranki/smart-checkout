/**
 * Unit tests for custom error classes (SPEC.md §7).
 * Verifies each error carries the correct HTTP status and error code.
 */

import {
  CartEmptyError,
  InvalidRequestError,
  PaymentFailedError,
  OrderConflictError,
  PricingError,
  InternalError,
} from '../src/utils/errors';

describe('CheckoutError subclasses', () => {
  it('CartEmptyError has correct code and status', () => {
    const err = new CartEmptyError();
    expect(err.code).toBe('CART_EMPTY');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe('The cart must contain at least one item.');
  });

  it('InvalidRequestError has correct code and status', () => {
    const err = new InvalidRequestError('cartId is required.');
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe('cartId is required.');
  });

  it('PaymentFailedError has correct code, status, and default message', () => {
    const err = new PaymentFailedError();
    expect(err.code).toBe('PAYMENT_FAILED');
    expect(err.httpStatus).toBe(402);
    expect(err.message).toContain('Payment could not be captured');
  });

  it('PaymentFailedError accepts a custom reason', () => {
    const err = new PaymentFailedError('Card expired.');
    expect(err.message).toBe('Card expired.');
  });

  it('OrderConflictError has correct code and status', () => {
    const err = new OrderConflictError();
    expect(err.code).toBe('ORDER_CONFLICT');
    expect(err.httpStatus).toBe(409);
  });

  it('PricingError has correct code and status', () => {
    const err = new PricingError('Total negative.');
    expect(err.code).toBe('PRICING_ERROR');
    expect(err.httpStatus).toBe(422);
  });

  it('PricingError uses default message when no reason given', () => {
    const err = new PricingError();
    expect(err.message).toContain('Server could not calculate a valid total');
  });

  it('InternalError has correct code and status', () => {
    const err = new InternalError();
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.httpStatus).toBe(500);
  });
});
