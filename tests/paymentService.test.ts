/**
 * Unit tests for paymentService.capturePayment.
 * Tests the mock implementation directly (no Lambda context needed).
 *
 * In production the real gateway call would be covered by integration tests.
 */

import { capturePayment } from '../src/services/paymentService';
import { PaymentFailedError } from '../src/utils/errors';
import { PaymentMethod } from '../src/types';

const cardMethod: PaymentMethod = { type: 'card', token: 'tok_visa_test' };
const walletMethod: PaymentMethod = { type: 'wallet', token: 'tok_gpay_test' };
const failMethod: PaymentMethod = { type: 'card', token: 'fail_declined' };

describe('capturePayment', () => {
  it('returns SUCCESS with a transactionId for a valid card token', async () => {
    const result = await capturePayment('ord_001', 55.00, cardMethod);
    expect(result.status).toBe('SUCCESS');
    expect(result.transactionId).toMatch(/^txn_ord_001_/);
  });

  it('returns SUCCESS for a wallet token', async () => {
    const result = await capturePayment('ord_002', 20.00, walletMethod);
    expect(result.status).toBe('SUCCESS');
  });

  it('throws PaymentFailedError when token starts with fail_', async () => {
    await expect(capturePayment('ord_003', 50.00, failMethod))
      .rejects.toThrow(PaymentFailedError);
  });

  it('throws PaymentFailedError with a descriptive message for fail_ token', async () => {
    await expect(capturePayment('ord_004', 50.00, failMethod))
      .rejects.toThrow('Payment declined by gateway');
  });
});
