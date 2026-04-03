/**
 * Unit tests for cartValidator.
 * Covers SPEC.md §3.1 field rules and §8 edge cases.
 * Maps to AC-01, AC-02, AC-12, AC-13, AC-14.
 */

import { validateCheckoutRequest } from '../src/validators/cartValidator';
import { CartEmptyError, InvalidRequestError } from '../src/utils/errors';

const validBody = {
  cartId: 'cart_abc123',
  customerId: 'cust_xyz',
  items: [
    { productId: 'prod_1', name: 'Widget', quantity: 2, unitPrice: 9.99 },
  ],
  paymentMethod: { type: 'card', token: 'tok_visa' },
};

describe('cartValidator', () => {
  it('accepts a valid request', () => {
    const result = validateCheckoutRequest(validBody);
    expect(result.cartId).toBe('cart_abc123');
    expect(result.items).toHaveLength(1);
  });

  // AC-01 — Checkout fails if cart is empty
  it('AC-01: throws CartEmptyError when items array is empty', () => {
    expect(() => validateCheckoutRequest({ ...validBody, items: [] }))
      .toThrow(CartEmptyError);
  });

  // AC-02 — Checkout fails if items field is missing
  it('AC-02: throws InvalidRequestError when items field is missing', () => {
    const { items: _items, ...noItems } = validBody;
    expect(() => validateCheckoutRequest(noItems)).toThrow(InvalidRequestError);
  });

  // AC-12 — Missing cartId
  it('AC-12: throws InvalidRequestError when cartId is missing', () => {
    const { cartId: _id, ...noCart } = validBody;
    expect(() => validateCheckoutRequest(noCart)).toThrow(InvalidRequestError);
  });

  it('AC-12: throws InvalidRequestError when cartId is empty string', () => {
    expect(() => validateCheckoutRequest({ ...validBody, cartId: '' }))
      .toThrow(InvalidRequestError);
  });

  // AC-13 — quantity = 0 fails
  it('AC-13: throws InvalidRequestError when quantity is 0', () => {
    const items = [{ ...validBody.items[0], quantity: 0 }];
    expect(() => validateCheckoutRequest({ ...validBody, items }))
      .toThrow(InvalidRequestError);
  });

  it('AC-13: throws InvalidRequestError when quantity is negative', () => {
    const items = [{ ...validBody.items[0], quantity: -1 }];
    expect(() => validateCheckoutRequest({ ...validBody, items }))
      .toThrow(InvalidRequestError);
  });

  // AC-14 — unitPrice = 0 fails
  it('AC-14: throws InvalidRequestError when unitPrice is 0', () => {
    const items = [{ ...validBody.items[0], unitPrice: 0 }];
    expect(() => validateCheckoutRequest({ ...validBody, items }))
      .toThrow(InvalidRequestError);
  });

  it('AC-14: throws InvalidRequestError when unitPrice is negative', () => {
    const items = [{ ...validBody.items[0], unitPrice: -5.00 }];
    expect(() => validateCheckoutRequest({ ...validBody, items }))
      .toThrow(InvalidRequestError);
  });

  describe('paymentMethod validation', () => {
    it('throws InvalidRequestError when paymentMethod is missing', () => {
      const { paymentMethod: _pm, ...noPayment } = validBody;
      expect(() => validateCheckoutRequest(noPayment)).toThrow(InvalidRequestError);
    });

    it('throws InvalidRequestError when paymentMethod.type is invalid', () => {
      const body = { ...validBody, paymentMethod: { type: 'bitcoin', token: 'tok_abc' } };
      expect(() => validateCheckoutRequest(body)).toThrow(InvalidRequestError);
    });

    it('accepts wallet as paymentMethod.type', () => {
      const body = { ...validBody, paymentMethod: { type: 'wallet', token: 'tok_gpay' } };
      expect(() => validateCheckoutRequest(body)).not.toThrow();
    });
  });

  describe('edge cases (SPEC.md §8)', () => {
    it('trims whitespace from cartId', () => {
      const result = validateCheckoutRequest({ ...validBody, cartId: '  cart_001  ' });
      expect(result.cartId).toBe('cart_001');
    });

    it('allows duplicate productId within same cart', () => {
      const items = [
        { productId: 'prod_1', name: 'Widget', quantity: 1, unitPrice: 10 },
        { productId: 'prod_1', name: 'Widget', quantity: 2, unitPrice: 10 },
      ];
      expect(() => validateCheckoutRequest({ ...validBody, items })).not.toThrow();
    });

    it('rejects body that is not an object', () => {
      expect(() => validateCheckoutRequest('invalid')).toThrow(InvalidRequestError);
    });

    it('rejects null body', () => {
      expect(() => validateCheckoutRequest(null)).toThrow(InvalidRequestError);
    });
  });
});
