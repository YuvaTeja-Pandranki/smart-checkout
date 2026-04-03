/**
 * Lambda handler: POST /checkout
 *
 * Orchestrates the checkout flow (SPEC.md §2).
 * All business logic lives in validators, services, and the repository —
 * this file just calls them in order and handles errors.
 *
 * Flow:
 *   1. Parse + validate request  (cartValidator)
 *   2. Idempotency check         (orderRepository.findOrderByCartId)
 *   3. Calculate server total    (pricingService)
 *   4. Persist order as PENDING  (orderRepository.createOrder)
 *   5. Capture payment           (paymentService.capturePayment)
 *   6. Update order to CONFIRMED (orderRepository.updateOrderStatus)
 *   7. Return 201 response
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { randomUUID } from 'crypto';

import { ApiResponse, CheckoutErrorResponse, CheckoutSuccessResponse } from '../types';
import { validateCheckoutRequest } from '../validators/cartValidator';
import { calculatePricing } from '../services/pricingService';
import { capturePayment } from '../services/paymentService';
import {
  findOrderByCartId,
  createOrder,
  updateOrderStatus,
  buildOrder,
} from '../repositories/orderRepository';
import { CheckoutError } from '../utils/errors';
import { logger } from '../utils/logger';

// ── Helpers ──────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function success(statusCode: number, data: CheckoutSuccessResponse): ApiResponse {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(data) };
}

function failure(statusCode: number, data: CheckoutErrorResponse): ApiResponse {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(data) };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  const requestId = context.awsRequestId ?? randomUUID();

  // ── Step 1: Parse and validate request ────────────────────────────────────
  let parsed;
  try {
    const body = JSON.parse(event.body ?? '{}') as unknown;
    parsed = validateCheckoutRequest(body);
  } catch (err) {
    if (err instanceof CheckoutError) {
      logger.warn('Validation error', { errorCode: err.code, requestId, message: err.message });
      const res: CheckoutErrorResponse = {
        success: false,
        error: { code: err.code, message: err.message, requestId },
      };
      return failure(err.httpStatus, res);
    }
    logger.error('Failed to parse request body', { requestId, errorMessage: String(err) });
    const res: CheckoutErrorResponse = {
      success: false,
      error: { code: 'INVALID_REQUEST', message: 'Request body is not valid JSON.', requestId },
    };
    return failure(400, res);
  }

  const { cartId, customerId, items, paymentMethod } = parsed;

  logger.info('Checkout request received', {
    requestId,
    cartId,
    customerId,
    itemCount: items.length,
  });

  // ── Step 2: Idempotency check ─────────────────────────────────────────────
  try {
    const existing = await findOrderByCartId(cartId);
    if (existing !== null) {
      logger.info('Idempotent hit — returning existing order', {
        requestId,
        cartId,
        orderId: existing.orderId,
      });
      // Return the stored response blob unchanged (SPEC.md §5)
      return success(200, existing.checkoutResponse);
    }
  } catch (err) {
    logger.error('DynamoDB read failed during idempotency check', {
      requestId,
      errorMessage: String(err),
    });
    const res: CheckoutErrorResponse = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again.', requestId },
    };
    return failure(500, res);
  }

  // ── Step 3: Calculate server-side total ───────────────────────────────────
  let pricing;
  try {
    pricing = calculatePricing(items);
  } catch (err) {
    if (err instanceof CheckoutError) {
      logger.warn('Pricing error', { requestId, cartId, errorCode: err.code });
      const res: CheckoutErrorResponse = {
        success: false,
        error: { code: err.code, message: err.message, requestId },
      };
      return failure(err.httpStatus, res);
    }
    logger.error('Unexpected pricing error', { requestId, errorMessage: String(err) });
    const res: CheckoutErrorResponse = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again.', requestId },
    };
    return failure(500, res);
  }

  // ── Step 4: Persist order (PENDING) ──────────────────────────────────────
  const orderId = `ord_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = new Date().toISOString();

  // Build the canonical success response now so it is stored in the order record.
  // This ensures idempotent retries (step 2) always return the same body.
  const checkoutResponse: CheckoutSuccessResponse = {
    success: true,
    orderId,
    cartId,
    status: 'CONFIRMED',   // Optimistic — will be updated if payment fails
    total: pricing.total,
    currency: 'USD',
    createdAt,
  };

  const order = buildOrder({
    cartId,
    orderId,
    customerId,
    items,
    pricing,
    checkoutResponse,
  });

  try {
    await createOrder(order);
    logger.info('Order created', { requestId, cartId, orderId, total: pricing.total });
  } catch (err: unknown) {
    // ConditionalCheckFailedException → race condition, another Lambda won
    const errName = (err as { name?: string }).name ?? '';
    if (errName === 'ConditionalCheckFailedException') {
      logger.info('Race condition on order write — re-reading existing order', {
        requestId,
        cartId,
      });
      try {
        const existing = await findOrderByCartId(cartId);
        if (existing !== null) return success(200, existing.checkoutResponse);
      } catch {
        // fall through to 500
      }
    }
    logger.error('Failed to write order to DynamoDB', { requestId, errorMessage: String(err) });
    const res: CheckoutErrorResponse = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again.', requestId },
    };
    return failure(500, res);
  }

  // ── Step 5: Capture payment (only after order is written) ─────────────────
  try {
    await capturePayment(orderId, pricing.total, paymentMethod);
    logger.info('Payment captured', { requestId, cartId, orderId });
  } catch (err) {
    // Payment failed — update status and return 402
    logger.warn('Payment failed', {
      requestId,
      cartId,
      orderId,
      reason: String(err),
    });

    const failedResponse: CheckoutSuccessResponse = {
      ...checkoutResponse,
      status: 'PAYMENT_FAILED',
    };

    try {
      await updateOrderStatus(cartId, 'PAYMENT_FAILED', failedResponse);
    } catch (updateErr) {
      logger.error('Could not update order status after payment failure', {
        requestId,
        errorMessage: String(updateErr),
      });
      // Still return 402 to the client even if the status update fails
    }

    const paymentErr = err instanceof CheckoutError ? err.message : 'Payment could not be captured. Please try a different payment method.';
    const res: CheckoutErrorResponse = {
      success: false,
      error: { code: 'PAYMENT_FAILED', message: paymentErr, requestId },
    };
    return failure(402, res);
  }

  // ── Step 6: Confirm order ─────────────────────────────────────────────────
  try {
    await updateOrderStatus(cartId, 'CONFIRMED', checkoutResponse);
  } catch (err) {
    // Non-fatal — payment already captured. Log and continue.
    logger.warn('Could not update order status to CONFIRMED (payment already captured)', {
      requestId,
      cartId,
      orderId,
      errorMessage: String(err),
    });
  }

  // ── Step 7: Return success ────────────────────────────────────────────────
  logger.info('Checkout complete', { requestId, cartId, orderId, total: pricing.total });
  return success(201, checkoutResponse);
}
