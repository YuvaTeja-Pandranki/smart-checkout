/**
 * Unit tests for pricingService.
 * Covers SPEC.md §4 pricing rules and AC-03 through AC-06.
 */

import { calculatePricing } from '../src/services/pricingService';
import { CartItem } from '../src/types';
import { PricingError } from '../src/utils/errors';

function makeItem(quantity: number, unitPrice: number): CartItem {
  return { productId: 'prod_1', name: 'Test Item', quantity, unitPrice };
}

describe('pricingService', () => {
  // AC-03 — Server recalculates total; ignores any client-supplied total
  describe('AC-03: server owns the total', () => {
    it('calculates the total from items, not from any caller-supplied value', () => {
      const items = [makeItem(2, 10.00)];
      const result = calculatePricing(items);
      // 2 × 10 = 20, tax 10% = 2.00, no discount, total = 22.00
      expect(result.total).toBe(22.00);
    });
  });

  // AC-04 — Tax is 10% of subtotal
  describe('AC-04: 10% tax applied', () => {
    it('applies 10% tax to a simple cart', () => {
      const items = [makeItem(1, 50.00)];
      const result = calculatePricing(items);
      expect(result.subtotal).toBe(50.00);
      expect(result.tax).toBe(5.00);
    });

    it('rounds tax to 2 decimal places', () => {
      const items = [makeItem(1, 33.33)];
      const result = calculatePricing(items);
      // 33.33 × 0.10 = 3.333 → rounds to 3.33
      expect(result.tax).toBe(3.33);
    });
  });

  // AC-05 — 5% discount when subtotal >= 100
  describe('AC-05: 5% discount at subtotal >= 100', () => {
    it('applies 5% discount when subtotal is exactly 100', () => {
      const items = [makeItem(1, 100.00)];
      const result = calculatePricing(items);
      expect(result.discount).toBe(5.00);
      // total = 100 + 10 - 5 = 105
      expect(result.total).toBe(105.00);
    });

    it('applies 5% discount when subtotal is well above 100', () => {
      const items = [makeItem(2, 100.00)];
      const result = calculatePricing(items);
      // subtotal = 200, tax = 20, discount = 10, total = 210
      expect(result.subtotal).toBe(200.00);
      expect(result.discount).toBe(10.00);
      expect(result.total).toBe(210.00);
    });
  });

  // AC-06 — No discount when subtotal < 100
  describe('AC-06: no discount when subtotal < 100', () => {
    it('does not apply discount when subtotal is 99.99', () => {
      const items = [makeItem(1, 99.99)];
      const result = calculatePricing(items);
      expect(result.discount).toBe(0);
    });

    it('does not apply discount when subtotal is small', () => {
      const items = [makeItem(1, 10.00)];
      const result = calculatePricing(items);
      expect(result.discount).toBe(0);
    });
  });

  describe('multi-item carts', () => {
    it('sums multiple items correctly', () => {
      const items = [makeItem(3, 10.00), makeItem(2, 5.00)];
      const result = calculatePricing(items);
      // subtotal = 30 + 10 = 40, tax = 4, discount = 0, total = 44
      expect(result.subtotal).toBe(40.00);
      expect(result.total).toBe(44.00);
    });
  });

  describe('pricing invariants (SPEC.md §4.5)', () => {
    it('throws PricingError when total would exceed 999999.99', () => {
      const items = [makeItem(1000, 999.99)];
      expect(() => calculatePricing(items)).toThrow(PricingError);
    });

    it('returns USD as currency', () => {
      const result = calculatePricing([makeItem(1, 10.00)]);
      expect(result.currency).toBe('USD');
    });
  });
});
