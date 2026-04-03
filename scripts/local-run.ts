/**
 * Local runner — calls the Lambda handler directly against real AWS DynamoDB.
 * No deployment needed. Uses your local AWS credentials.
 *
 * Usage:
 *   ORDERS_TABLE_NAME=checkout-orders-dev npx ts-node --project tsconfig.scripts.json scripts/local-run.ts
 */

// Point at the real table that already exists
process.env['ORDERS_TABLE_NAME'] = process.env['ORDERS_TABLE_NAME'] ?? 'checkout-orders-dev';
process.env['AWS_REGION'] = process.env['AWS_REGION'] ?? 'us-east-1';

import { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { handler } from '../src/handlers/checkout';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /checkout',
    rawPath: '/checkout',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const fakeContext: Context = {
  awsRequestId: `local-${Date.now()}`,
  functionName: 'smart-checkout-local',
} as unknown as Context;

// ── Scenarios ─────────────────────────────────────────────────────────────────

const CART_ID = `cart_local_${Date.now()}`;

const checkoutPayload = {
  cartId: CART_ID,
  customerId: 'cust_local_001',
  items: [
    { productId: 'prod_001', name: 'Wireless Mouse', quantity: 2, unitPrice: 29.99 },
    { productId: 'prod_002', name: 'USB Hub',        quantity: 1, unitPrice: 19.99 },
  ],
  paymentMethod: { type: 'card', token: 'tok_visa_test' },
};

// ── Run ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Smart Checkout — Local Runner (hitting real DynamoDB)');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Table : ${process.env['ORDERS_TABLE_NAME']}`);
  console.log(`Region: ${process.env['AWS_REGION']}`);
  console.log(`CartId: ${CART_ID}\n`);

  // ── First request: should create a new order ──────────────────────────────
  console.log('─── Request 1: new checkout ──────────────────────────────');
  const res1 = await handler(makeEvent(checkoutPayload), fakeContext);
  const body1 = JSON.parse((res1 as { body: string }).body);
  console.log('Status :', (res1 as { statusCode: number }).statusCode);
  console.log('Body   :', JSON.stringify(body1, null, 2));

  // ── Second request: same cartId — should return identical response ─────────
  console.log('\n─── Request 2: same cartId (idempotency check) ───────────');
  const res2 = await handler(makeEvent(checkoutPayload), fakeContext);
  const body2 = JSON.parse((res2 as { body: string }).body);
  console.log('Status :', (res2 as { statusCode: number }).statusCode);
  console.log('Body   :', JSON.stringify(body2, null, 2));

  const sameOrderId = body1.orderId === body2.orderId;
  console.log(`\n✔ Same orderId returned on retry: ${sameOrderId} (${body1.orderId})`);

  // ── Empty cart: should fail validation ────────────────────────────────────
  console.log('\n─── Request 3: empty cart (validation) ───────────────────');
  const res3 = await handler(
    makeEvent({ ...checkoutPayload, cartId: `cart_empty_${Date.now()}`, items: [] }),
    fakeContext,
  );
  const body3 = JSON.parse((res3 as { body: string }).body);
  console.log('Status :', (res3 as { statusCode: number }).statusCode);
  console.log('Body   :', JSON.stringify(body3, null, 2));

  // ── Failed payment ─────────────────────────────────────────────────────────
  console.log('\n─── Request 4: declined payment ──────────────────────────');
  const res4 = await handler(
    makeEvent({
      ...checkoutPayload,
      cartId: `cart_fail_${Date.now()}`,
      paymentMethod: { type: 'card', token: 'fail_declined' },
    }),
    fakeContext,
  );
  const body4 = JSON.parse((res4 as { body: string }).body);
  console.log('Status :', (res4 as { statusCode: number }).statusCode);
  console.log('Body   :', JSON.stringify(body4, null, 2));

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' Done. Check DynamoDB table to verify the items written.');
  console.log(`  aws dynamodb get-item --table-name ${process.env['ORDERS_TABLE_NAME']} \\`);
  console.log(`    --key '{"cartId":{"S":"${CART_ID}"}}'`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

run().catch((err) => {
  console.error('Runner failed:', err);
  process.exit(1);
});
