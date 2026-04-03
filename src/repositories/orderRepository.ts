/**
 * DynamoDB repository for orders.
 *
 * Implements the idempotency design from SPEC.md §5:
 *   1. GetItem by cartId — return existing if found
 *   2. PutItem with condition attribute_not_exists(cartId)
 *   3. On conditional check failure — re-read and return existing
 *
 * Schema: SPEC.md §6
 * No secrets in code: table name comes from ORDERS_TABLE_NAME env var (SPEC.md §9.1)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Order, OrderStatus, CheckoutSuccessResponse } from '../types';

// ── DynamoDB client ──────────────────────────────────────────────────────────

const rawClient = new DynamoDBClient({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
});

const client = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env['ORDERS_TABLE_NAME'] ?? 'checkout-orders';

// TTL: 90 days in seconds
const TTL_SECONDS = 90 * 24 * 60 * 60;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up an existing order by cartId.
 * Returns null when no order exists for this cart.
 */
export async function findOrderByCartId(cartId: string): Promise<Order | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { cartId },
    }),
  );

  return (result.Item as Order | undefined) ?? null;
}

/**
 * Write a new order record.
 * Uses a conditional expression to prevent overwriting an existing record.
 *
 * @throws ConditionalCheckFailedException if cartId already exists (race condition).
 *         The caller should handle this by re-reading via findOrderByCartId.
 */
export async function createOrder(order: Order): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: order,
      // Idempotency guard — only write if cartId is new (SPEC.md §5)
      ConditionExpression: 'attribute_not_exists(cartId)',
    }),
  );
}

/**
 * Update the status of an existing order (e.g. CONFIRMED or PAYMENT_FAILED).
 * Also updates the stored checkoutResponse blob so idempotent retries return
 * the correct response after status transitions.
 */
export async function updateOrderStatus(
  cartId: string,
  status: OrderStatus,
  checkoutResponse: CheckoutSuccessResponse,
): Promise<void> {
  const updatedAt = new Date().toISOString();

  await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { cartId },
      UpdateExpression:
        'SET #status = :status, updatedAt = :updatedAt, checkoutResponse = :checkoutResponse',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':updatedAt': updatedAt,
        ':checkoutResponse': checkoutResponse,
      },
    }),
  );
}

// ── Factory helpers ──────────────────────────────────────────────────────────

/**
 * Build an Order domain object ready to be persisted.
 * Extracted here so the handler stays free of DynamoDB-specific details.
 */
export function buildOrder(params: {
  cartId: string;
  orderId: string;
  customerId: string;
  items: Order['items'];
  pricing: { subtotal: number; tax: number; discount: number; total: number };
  checkoutResponse: CheckoutSuccessResponse;
}): Order {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  return {
    cartId: params.cartId,
    orderId: params.orderId,
    customerId: params.customerId,
    status: 'PENDING',
    items: params.items,
    subtotal: params.pricing.subtotal,
    tax: params.pricing.tax,
    discount: params.pricing.discount,
    total: params.pricing.total,
    currency: 'USD',
    checkoutResponse: params.checkoutResponse,
    createdAt: now,
    updatedAt: now,
    ttl,
  };
}
