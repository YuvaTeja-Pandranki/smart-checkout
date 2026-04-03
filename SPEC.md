# Smart Order Fulfillment — Checkout Service Specification

> **This file is the source of truth.**
> If the code and this spec ever disagree, the spec wins.
> When behaviour changes, update this file first — then the code.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Checkout Flow](#2-checkout-flow)
3. [API Contract](#3-api-contract)
4. [Pricing Rules](#4-pricing-rules)
5. [Idempotency Design](#5-idempotency-design)
6. [DynamoDB Schema](#6-dynamodb-schema)
7. [Error Catalogue](#7-error-catalogue)
8. [Edge Cases](#8-edge-cases)
9. [Security Rules](#9-security-rules)
10. [Acceptance Criteria](#10-acceptance-criteria)
11. [Logging Requirements](#11-logging-requirements)

---

## 1. Overview

The checkout service is a single serverless function exposed via API Gateway. It accepts a cart, computes the authoritative total on the server, creates an order record, and captures payment — in that exact order. The key design constraint is that no step can be skipped or reordered: payment only happens after the order exists in the database.

**Technology decisions:**

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript | Type-safety reduces a class of runtime errors |
| Runtime | AWS Lambda | Stateless, scales to zero, no server management |
| API entry point | API Gateway (HTTP API) | Low latency, built-in auth support |
| Storage | DynamoDB (single table) | Serverless, millisecond reads, conditional writes for idempotency |
| Idempotency key | `cartId` supplied by client | Stable across retries; scoped to a single cart lifecycle |

---

## 2. Checkout Flow

```
Client
  │
  │  POST /checkout  { cartId, customerId, items[], paymentMethod }
  ▼
API Gateway
  │
  ▼
Lambda: checkout handler
  │
  ├─ [1] Validate request schema
  │       • cartId present and non-empty string
  │       • customerId present
  │       • items array non-empty
  │       • each item has productId (string), quantity (int ≥ 1), unitPrice (number > 0)
  │       • paymentMethod present
  │       ↳ FAIL → 400 INVALID_REQUEST
  │
  ├─ [2] Idempotency check (DynamoDB GetItem by cartId)
  │       • If order already exists → return stored response immediately (200)
  │       ↳ EXISTING ORDER → 200 (same body as original success)
  │
  ├─ [3] Recalculate total on server
  │       • Server ignores any client-supplied total
  │       • Applies pricing rules (see §4)
  │       ↳ FAIL (negative total, overflow) → 500 PRICING_ERROR
  │
  ├─ [4] Create order record in DynamoDB
  │       • Uses a conditional write: only succeeds if cartId does NOT yet exist
  │       • Status set to PENDING
  │       ↳ FAIL (condition check fails = race condition) → re-read and return existing (200)
  │
  ├─ [5] Capture payment
  │       • Called only after order record is successfully written
  │       • On failure: order status updated to PAYMENT_FAILED
  │       ↳ FAIL → 402 PAYMENT_FAILED
  │
  └─ [6] Update order status to CONFIRMED, return success response
          → 201 CREATED
```

---

## 3. API Contract

### 3.1 Request

```
POST /checkout
Content-Type: application/json
```

```json
{
  "cartId":        "cart_abc123",
  "customerId":    "cust_xyz789",
  "items": [
    {
      "productId":  "prod_001",
      "name":       "Wireless Mouse",
      "quantity":   2,
      "unitPrice":  29.99
    }
  ],
  "paymentMethod": {
    "type":   "card",
    "token":  "tok_visa_test"
  }
}
```

**Field rules:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `cartId` | string | ✅ | Non-empty, max 128 chars |
| `customerId` | string | ✅ | Non-empty, max 128 chars |
| `items` | array | ✅ | Length ≥ 1, max 100 items |
| `items[].productId` | string | ✅ | Non-empty |
| `items[].name` | string | ✅ | Non-empty |
| `items[].quantity` | integer | ✅ | ≥ 1, ≤ 1000 |
| `items[].unitPrice` | number | ✅ | > 0, ≤ 999999.99 |
| `paymentMethod` | object | ✅ | Must have `type` and `token` |
| `paymentMethod.type` | string | ✅ | One of: `card`, `wallet` |
| `paymentMethod.token` | string | ✅ | Non-empty |

> **Security note:** `unitPrice` is accepted from the client only to display line items.
> The server **always recomputes** the authoritative total. Client-supplied prices are **never trusted** for billing.

### 3.2 Success Response — 201 Created

Returned when a new order is successfully created and payment captured.

```json
{
  "success": true,
  "orderId": "ord_8f3a12bc",
  "cartId":  "cart_abc123",
  "status":  "CONFIRMED",
  "total":   59.98,
  "currency": "USD",
  "createdAt": "2026-04-01T10:00:00.000Z"
}
```

### 3.3 Idempotent Repeat Response — 200 OK

Returned when the same `cartId` is submitted again and the order already exists.
The body is **identical** to the original success response.

```json
{
  "success": true,
  "orderId": "ord_8f3a12bc",
  "cartId":  "cart_abc123",
  "status":  "CONFIRMED",
  "total":   59.98,
  "currency": "USD",
  "createdAt": "2026-04-01T10:00:00.000Z"
}
```

### 3.4 Error Response — All Failures

```json
{
  "success": false,
  "error": {
    "code":    "CART_EMPTY",
    "message": "The cart must contain at least one item.",
    "requestId": "req_abc123"
  }
}
```

---

## 4. Pricing Rules

All pricing is computed server-side. The client-supplied `unitPrice` is used only for line-item display purposes and is **not** used in the authoritative total calculation.

> **Note (MVP):** In this implementation, the server uses the client-supplied `unitPrice` as the catalogue price because there is no product database. In production, prices would be fetched from a product catalogue service. The key invariant is that the server owns the total calculation — it is never taken from a client-supplied `total` field.

### 4.1 Subtotal

```
subtotal = Σ (item.quantity × item.unitPrice)
```

Each line is rounded to 2 decimal places before summing.

### 4.2 Tax

```
tax = round(subtotal × 0.10, 2)   // 10% flat rate (MVP)
```

### 4.3 Discount

```
if subtotal >= 100.00 → discount = round(subtotal × 0.05, 2)  // 5% loyalty discount
else                  → discount = 0.00
```

### 4.4 Total

```
total = subtotal + tax - discount
total = round(total, 2)
```

### 4.5 Invariants

- `total` must be > 0
- `total` must not exceed 999999.99
- All monetary values are rounded to exactly 2 decimal places
- Currency is always `USD` in this implementation

---

## 5. Idempotency Design

**Key:** `cartId`
**Storage:** DynamoDB `orders` table, with `cartId` as the partition key.

### How it works

1. On every request, the handler first calls `GetItem` using `cartId`.
2. If an item is found, the stored `checkoutResponse` blob is returned immediately — no processing occurs.
3. If no item is found, a `PutItem` is attempted with a **condition expression**: `attribute_not_exists(cartId)`.
4. If the conditional write fails (another concurrent request won the race), the handler retries the `GetItem` and returns the existing record.

### Guarantees

- A given `cartId` produces **at most one order**.
- Retries after a network failure will receive the same response as the original call.
- Payment is **never charged twice** for the same `cartId`.

---

## 6. DynamoDB Schema

**Table name:** `checkout-orders` (injected via `ORDERS_TABLE_NAME` environment variable)
**Billing mode:** PAY_PER_REQUEST
**Primary key:** `cartId` (String, partition key)

### Item structure

```json
{
  "cartId":           "cart_abc123",
  "orderId":          "ord_8f3a12bc",
  "customerId":       "cust_xyz789",
  "status":           "CONFIRMED",
  "items":            [ ... ],
  "subtotal":         54.53,
  "tax":              5.45,
  "discount":         0.00,
  "total":            59.98,
  "currency":         "USD",
  "checkoutResponse": { ... },
  "createdAt":        "2026-04-01T10:00:00.000Z",
  "updatedAt":        "2026-04-01T10:00:01.000Z",
  "ttl":              1775000400
}
```

`ttl` is set to `now + 90 days` to prevent unbounded table growth.

---

## 7. Error Catalogue

| HTTP Status | Code | Message | When |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | Validation message (field-specific) | Schema validation fails |
| 400 | `CART_EMPTY` | The cart must contain at least one item. | `items` array is empty |
| 402 | `PAYMENT_FAILED` | Payment could not be captured. Please try a different payment method. | Payment service returns failure |
| 409 | `ORDER_CONFLICT` | An order for this cart is currently being processed. | Race condition during write (transient) |
| 422 | `PRICING_ERROR` | Server could not calculate a valid total for this cart. | Pricing invariant violated |
| 500 | `INTERNAL_ERROR` | An unexpected error occurred. Please try again. | Unhandled exceptions |

---

## 8. Edge Cases

| Scenario | Expected Behaviour |
|---|---|
| Empty `items` array | 400 CART_EMPTY |
| `items` array missing | 400 INVALID_REQUEST |
| `quantity` = 0 | 400 INVALID_REQUEST |
| `unitPrice` = 0 | 400 INVALID_REQUEST |
| `unitPrice` negative | 400 INVALID_REQUEST |
| Duplicate `productId` within same cart | Allowed — treated as two line items |
| `cartId` already exists (idempotent retry) | 200 with original response |
| `cartId` exists but status is `PAYMENT_FAILED` | 200 with original PAYMENT_FAILED error response — client must use a new `cartId` to retry |
| Total exceeds 999999.99 | 422 PRICING_ERROR |
| Payment fails after order written | Order status set to `PAYMENT_FAILED`; 402 returned |
| DynamoDB unavailable | 500 INTERNAL_ERROR |
| Missing required field | 400 INVALID_REQUEST with specific field name |

---

## 9. Security Rules

1. **No secrets in code.** All configuration (table name, region, payment keys) must come from environment variables.
2. **Server-owned pricing.** The server must never use a client-supplied `total` value for billing. Client `unitPrice` is used only to calculate the server-side total (see §4 note). In production, prices must come from an internal catalogue.
3. **Input validation.** All inputs are validated and sanitised before use. Strings are trimmed. Numbers are parsed and range-checked.
4. **No PII in logs.** Log fields must not contain payment tokens, full card numbers, or raw customer identifiers beyond `customerId`.
5. **Structured error messages.** Error responses must never leak internal stack traces or DynamoDB error messages to the client.
6. **IAM least privilege.** The Lambda execution role should only have `dynamodb:GetItem`, `dynamodb:PutItem`, and `dynamodb:UpdateItem` on the specific table ARN.
7. **Request size limit.** API Gateway should be configured to reject bodies larger than 16 KB.

---

## 10. Acceptance Criteria

Each criterion maps to at least one unit test.

| ID | Criterion | Test file |
|---|---|---|
| AC-01 | Checkout returns 400 when `items` is empty | checkout.test.ts |
| AC-02 | Checkout returns 400 when `items` is missing | checkout.test.ts |
| AC-03 | Server recalculates total; client `total` field is ignored | pricing.test.ts |
| AC-04 | Tax is applied at 10% of subtotal | pricing.test.ts |
| AC-05 | 5% discount applied when subtotal ≥ 100 | pricing.test.ts |
| AC-06 | No discount when subtotal < 100 | pricing.test.ts |
| AC-07 | Repeated request with same `cartId` returns same response (idempotent) | checkout.test.ts |
| AC-08 | A second call never creates a second order record | checkout.test.ts |
| AC-09 | Payment is only called after order record is written | checkout.test.ts |
| AC-10 | Payment failure returns 402 and sets order status to PAYMENT_FAILED | checkout.test.ts |
| AC-11 | Successful checkout returns `orderId`, `total`, `status: CONFIRMED` | checkout.test.ts |
| AC-12 | Missing `cartId` returns 400 INVALID_REQUEST | checkout.test.ts |
| AC-13 | `quantity` of 0 returns 400 INVALID_REQUEST | checkout.test.ts |
| AC-14 | `unitPrice` of 0 returns 400 INVALID_REQUEST | checkout.test.ts |

---

## 11. Logging Requirements

All logs must be structured JSON written to stdout (CloudWatch picks these up automatically).

**Required log events:**

| Event | Level | Fields |
|---|---|---|
| Request received | INFO | `cartId`, `customerId`, `itemCount`, `requestId` |
| Idempotent hit | INFO | `cartId`, `orderId`, `requestId` |
| Order created | INFO | `cartId`, `orderId`, `total`, `requestId` |
| Payment captured | INFO | `cartId`, `orderId`, `requestId` |
| Payment failed | WARN | `cartId`, `orderId`, `reason`, `requestId` |
| Validation error | WARN | `cartId`, `errorCode`, `requestId` |
| Unexpected error | ERROR | `requestId`, `errorMessage` (no stack in production) |

---

