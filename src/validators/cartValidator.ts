/**
 * Cart and request validation.
 * Rules derive directly from SPEC.md §3.1 (Field rules) and §8 (Edge Cases).
 *
 * Each validation failure throws an InvalidRequestError or CartEmptyError
 * with a message that describes exactly which field/rule was violated.
 */

import { CheckoutRequest } from '../types';
import { CartEmptyError, InvalidRequestError } from '../utils/errors';

const MAX_STRING_LEN = 128;
const MAX_ITEMS = 100;
const MAX_QUANTITY = 1000;
const MAX_UNIT_PRICE = 999999.99;

export function validateCheckoutRequest(body: unknown): CheckoutRequest {
  if (body === null || typeof body !== 'object') {
    throw new InvalidRequestError('Request body must be a JSON object.');
  }

  const raw = body as Record<string, unknown>;

  // ── cartId ──────────────────────────────────────────────────────────────
  if (typeof raw['cartId'] !== 'string' || raw['cartId'].trim() === '') {
    throw new InvalidRequestError('cartId is required and must be a non-empty string.');
  }
  if (raw['cartId'].length > MAX_STRING_LEN) {
    throw new InvalidRequestError(`cartId must not exceed ${MAX_STRING_LEN} characters.`);
  }

  // ── customerId ──────────────────────────────────────────────────────────
  if (typeof raw['customerId'] !== 'string' || raw['customerId'].trim() === '') {
    throw new InvalidRequestError('customerId is required and must be a non-empty string.');
  }
  if (raw['customerId'].length > MAX_STRING_LEN) {
    throw new InvalidRequestError(`customerId must not exceed ${MAX_STRING_LEN} characters.`);
  }

  // ── items ───────────────────────────────────────────────────────────────
  if (!Array.isArray(raw['items'])) {
    throw new InvalidRequestError('items is required and must be an array.');
  }
  if (raw['items'].length === 0) {
    throw new CartEmptyError();
  }
  if (raw['items'].length > MAX_ITEMS) {
    throw new InvalidRequestError(`Cart must not contain more than ${MAX_ITEMS} items.`);
  }

  for (let i = 0; i < raw['items'].length; i++) {
    validateItem(raw['items'][i], i);
  }

  // ── paymentMethod ────────────────────────────────────────────────────────
  if (raw['paymentMethod'] === null || typeof raw['paymentMethod'] !== 'object') {
    throw new InvalidRequestError('paymentMethod is required and must be an object.');
  }
  const pm = raw['paymentMethod'] as Record<string, unknown>;

  if (pm['type'] !== 'card' && pm['type'] !== 'wallet') {
    throw new InvalidRequestError("paymentMethod.type must be 'card' or 'wallet'.");
  }
  if (typeof pm['token'] !== 'string' || pm['token'].trim() === '') {
    throw new InvalidRequestError('paymentMethod.token is required and must be a non-empty string.');
  }

  // All checks passed — cast and return
  return {
    cartId: (raw['cartId'] as string).trim(),
    customerId: (raw['customerId'] as string).trim(),
    items: (raw['items'] as Array<Record<string, unknown>>).map((item) => ({
      productId: (item['productId'] as string).trim(),
      name: (item['name'] as string).trim(),
      quantity: Number(item['quantity']),
      unitPrice: Number(item['unitPrice']),
    })),
    paymentMethod: {
      type: pm['type'] as 'card' | 'wallet',
      token: (pm['token'] as string).trim(),
    },
  };
}

function validateItem(item: unknown, index: number): void {
  if (item === null || typeof item !== 'object') {
    throw new InvalidRequestError(`items[${index}] must be an object.`);
  }

  const raw = item as Record<string, unknown>;
  const prefix = `items[${index}]`;

  if (typeof raw['productId'] !== 'string' || raw['productId'].trim() === '') {
    throw new InvalidRequestError(`${prefix}.productId is required and must be a non-empty string.`);
  }
  if (typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
    throw new InvalidRequestError(`${prefix}.name is required and must be a non-empty string.`);
  }

  const quantity = Number(raw['quantity']);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new InvalidRequestError(`${prefix}.quantity must be an integer >= 1.`);
  }
  if (quantity > MAX_QUANTITY) {
    throw new InvalidRequestError(`${prefix}.quantity must not exceed ${MAX_QUANTITY}.`);
  }

  const unitPrice = Number(raw['unitPrice']);
  if (!isFinite(unitPrice) || unitPrice <= 0) {
    throw new InvalidRequestError(`${prefix}.unitPrice must be a number > 0.`);
  }
  if (unitPrice > MAX_UNIT_PRICE) {
    throw new InvalidRequestError(`${prefix}.unitPrice must not exceed ${MAX_UNIT_PRICE}.`);
  }
}
