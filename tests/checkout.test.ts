/**
 * Integration-style unit tests for the Lambda handler.
 * DynamoDB and payment service are mocked.
 *
 * Covers AC-07 through AC-11 from SPEC.md §10.
 */

import { APIGatewayProxyEventV2, Context } from 'aws-lambda';

// ── Mock dependencies before importing the handler ───────────────────────────

jest.mock('../src/repositories/orderRepository', () => ({
  findOrderByCartId: jest.fn(),
  createOrder: jest.fn(),
  updateOrderStatus: jest.fn(),
  buildOrder: jest.requireActual('../src/repositories/orderRepository').buildOrder,
}));

jest.mock('../src/services/paymentService', () => ({
  capturePayment: jest.fn(),
}));

import { handler } from '../src/handlers/checkout';
import * as repo from '../src/repositories/orderRepository';
import * as payment from '../src/services/paymentService';
import { CheckoutSuccessResponse, CheckoutErrorResponse } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST' } },
    rawPath: '/checkout',
    rawQueryString: '',
    routeKey: 'POST /checkout',
    version: '2.0',
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const fakeContext: Context = {
  awsRequestId: 'req_test_001',
} as unknown as Context;

const validBody = {
  cartId: 'cart_test_001',
  customerId: 'cust_001',
  items: [{ productId: 'prod_1', name: 'Widget', quantity: 2, unitPrice: 25.00 }],
  paymentMethod: { type: 'card', token: 'tok_visa_test' },
};

// Pre-built success response for mock existing order
const existingSuccessResponse: CheckoutSuccessResponse = {
  success: true,
  orderId: 'ord_existing001',
  cartId: 'cart_test_001',
  status: 'CONFIRMED',
  total: 55.00,
  currency: 'USD',
  createdAt: '2026-04-01T10:00:00.000Z',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no existing order, payment succeeds
  (repo.findOrderByCartId as jest.Mock).mockResolvedValue(null);
  (repo.createOrder as jest.Mock).mockResolvedValue(undefined);
  (repo.updateOrderStatus as jest.Mock).mockResolvedValue(undefined);
  (payment.capturePayment as jest.Mock).mockResolvedValue({
    transactionId: 'txn_test_001',
    status: 'SUCCESS',
  });
});

describe('handler — successful checkout', () => {
  // AC-11 — Successful checkout returns orderId, total, status: CONFIRMED
  it('AC-11: returns 201 with orderId, total, and status CONFIRMED on first call', async () => {
    const res = await handler(makeEvent(validBody), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutSuccessResponse;

    expect((res as { statusCode: number }).statusCode).toBe(201);
    expect(body.success).toBe(true);
    expect(body.orderId).toMatch(/^ord_/);
    expect(body.status).toBe('CONFIRMED');
    expect(body.total).toBe(55.00);   // 2×25=50, tax=5, no discount(50<100), total=55
    expect(body.currency).toBe('USD');
    expect(body.cartId).toBe('cart_test_001');
  });

  // AC-09 — Payment called only after order is created
  it('AC-09: payment is captured only after order record is written', async () => {
    const callOrder: string[] = [];
    (repo.createOrder as jest.Mock).mockImplementation(async () => {
      callOrder.push('createOrder');
    });
    (payment.capturePayment as jest.Mock).mockImplementation(async () => {
      callOrder.push('capturePayment');
      return { transactionId: 'txn_001', status: 'SUCCESS' };
    });

    await handler(makeEvent(validBody), fakeContext);

    expect(callOrder).toEqual(['createOrder', 'capturePayment']);
  });
});

describe('handler — idempotency (AC-07, AC-08)', () => {
  // AC-07 — Repeated request returns same response
  it('AC-07: returns 200 with the stored response when cartId already exists', async () => {
    (repo.findOrderByCartId as jest.Mock).mockResolvedValue({
      cartId: 'cart_test_001',
      orderId: 'ord_existing001',
      checkoutResponse: existingSuccessResponse,
    });

    const res = await handler(makeEvent(validBody), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutSuccessResponse;

    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(body.orderId).toBe('ord_existing001');
    expect(body.total).toBe(55.00);
  });

  // AC-08 — Second call never creates a second order
  it('AC-08: createOrder is never called when order already exists', async () => {
    (repo.findOrderByCartId as jest.Mock).mockResolvedValue({
      cartId: 'cart_test_001',
      orderId: 'ord_existing001',
      checkoutResponse: existingSuccessResponse,
    });

    await handler(makeEvent(validBody), fakeContext);

    expect(repo.createOrder).not.toHaveBeenCalled();
    expect(payment.capturePayment).not.toHaveBeenCalled();
  });
});

describe('handler — payment failure (AC-10)', () => {
  // AC-10 — Payment failure returns 402 and marks order as PAYMENT_FAILED
  it('AC-10: returns 402 when payment is declined', async () => {
    (payment.capturePayment as jest.Mock).mockRejectedValue(
      new Error('Payment declined by gateway'),
    );

    const res = await handler(makeEvent(validBody), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutErrorResponse;

    expect((res as { statusCode: number }).statusCode).toBe(402);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PAYMENT_FAILED');
  });

  it('AC-10: updates order status to PAYMENT_FAILED when payment is declined', async () => {
    (payment.capturePayment as jest.Mock).mockRejectedValue(
      new Error('Payment declined'),
    );

    await handler(makeEvent(validBody), fakeContext);

    expect(repo.updateOrderStatus).toHaveBeenCalledWith(
      'cart_test_001',
      'PAYMENT_FAILED',
      expect.objectContaining({ status: 'PAYMENT_FAILED' }),
    );
  });
});

describe('handler — validation errors', () => {
  it('returns 400 CART_EMPTY when items array is empty', async () => {
    const res = await handler(makeEvent({ ...validBody, items: [] }), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutErrorResponse;

    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(body.error.code).toBe('CART_EMPTY');
  });

  it('returns 400 INVALID_REQUEST when cartId is missing', async () => {
    const { cartId: _id, ...noCart } = validBody;
    const res = await handler(makeEvent(noCart), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutErrorResponse;

    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST when body is not JSON', async () => {
    const event = {
      ...makeEvent({}),
      body: 'not-json',
    } as APIGatewayProxyEventV2;

    const res = await handler(event, fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutErrorResponse;

    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns requestId in error responses', async () => {
    const res = await handler(makeEvent({ ...validBody, items: [] }), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutErrorResponse;

    expect(body.error.requestId).toBe('req_test_001');
  });
});

describe('handler — DynamoDB failure paths', () => {
  it('returns 500 INTERNAL_ERROR when DynamoDB read fails during idempotency check', async () => {
    (repo.findOrderByCartId as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));

    const res = await handler(makeEvent(validBody), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutErrorResponse;

    expect((res as { statusCode: number }).statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 INTERNAL_ERROR when DynamoDB write fails', async () => {
    (repo.createOrder as jest.Mock).mockRejectedValue(new Error('Write timeout'));

    const res = await handler(makeEvent(validBody), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutErrorResponse;

    expect((res as { statusCode: number }).statusCode).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns existing order when ConditionalCheckFailedException occurs (race condition)', async () => {
    const raceError = new Error('ConditionalCheckFailedException');
    raceError.name = 'ConditionalCheckFailedException';
    (repo.createOrder as jest.Mock).mockRejectedValue(raceError);

    const raceWinnerResponse: CheckoutSuccessResponse = {
      success: true,
      orderId: 'ord_race_winner',
      cartId: 'cart_test_001',
      status: 'CONFIRMED',
      total: 55.00,
      currency: 'USD',
      createdAt: '2026-04-01T10:00:00.000Z',
    };
    (repo.findOrderByCartId as jest.Mock)
      .mockResolvedValueOnce(null)         // first call: no existing order (idempotency check)
      .mockResolvedValueOnce({             // second call: re-read after race condition
        cartId: 'cart_test_001',
        orderId: 'ord_race_winner',
        checkoutResponse: raceWinnerResponse,
      });

    const res = await handler(makeEvent(validBody), fakeContext);
    const body = JSON.parse((res as { body: string }).body) as CheckoutSuccessResponse;

    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(body.orderId).toBe('ord_race_winner');
  });
});

describe('handler — discount pricing', () => {
  it('applies 5% discount when subtotal >= 100 (2 items × 60 = 120)', async () => {
    const body = {
      ...validBody,
      cartId: 'cart_discount_test',
      items: [{ productId: 'p1', name: 'Premium Widget', quantity: 2, unitPrice: 60.00 }],
    };

    const res = await handler(makeEvent(body), fakeContext);
    const parsed = JSON.parse((res as { body: string }).body) as CheckoutSuccessResponse;

    // subtotal = 120, tax = 12, discount = 6, total = 126
    expect(parsed.total).toBe(126.00);
  });
});
