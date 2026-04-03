/**
 * Payment capture service.
 *
 * SPEC.md §2 Step 5: Payment is captured ONLY after the order record exists.
 * This file defines the interface and a mock implementation for testing.
 *
 * In production, replace `capturePayment` with a real call to Stripe / Braintree / etc.
 * The token from paymentMethod.token would be passed to the payment gateway SDK.
 * No secrets should be hardcoded here — use environment variables (SPEC.md §9.1).
 */

import { PaymentMethod } from '../types';
import { PaymentFailedError } from '../utils/errors';

export interface PaymentResult {
  transactionId: string;
  status: 'SUCCESS';
}

/**
 * Capture a payment for the given order.
 *
 * @param orderId   The order ID (used as idempotency key for the payment gateway).
 * @param amount    Amount to charge in USD.
 * @param method    Payment method (type + tokenised card/wallet reference).
 * @throws PaymentFailedError if the gateway declines or is unavailable.
 */
export async function capturePayment(
  orderId: string,
  _amount: number,
  method: PaymentMethod,
): Promise<PaymentResult> {
  // ── Production implementation stub ────────────────────────────────────────
  // const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { ... });
  // const intent = await stripeClient.paymentIntents.create({
  //   amount: Math.round(amount * 100),   // Stripe works in cents
  //   currency: 'usd',
  //   payment_method: method.token,
  //   confirm: true,
  //   idempotency_key: orderId,           // Prevents double-charges on retries
  // });
  // if (intent.status !== 'succeeded') throw new PaymentFailedError(intent.status);
  // return { transactionId: intent.id, status: 'SUCCESS' };

  // ── Mock implementation (always succeeds unless token starts with 'fail_') ─
  if (method.token.startsWith('fail_')) {
    throw new PaymentFailedError('Payment declined by gateway (test token).');
  }

  // Simulate a successful payment
  const transactionId = `txn_${orderId}_${Date.now()}`;
  return { transactionId, status: 'SUCCESS' };
}
