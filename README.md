# Smart Order Fulfillment — Checkout Service

A serverless checkout service built with **Node.js + TypeScript**, **AWS Lambda**, **API Gateway**, and **DynamoDB**. The spec ([SPEC.md](./SPEC.md)) was written before any code and is the single source of truth for how the service behaves.

---

## Quick Start

```bash
npm install
npm test          # run all unit tests (no AWS credentials needed)
npm run build     # type-check with tsc
```

---

## Project Structure

```
smart-checkout/
├── SPEC.md                         ← read this first
├── README.md
├── CLAUDE_USAGE.md                 ← how Claude was used during development
├── template.yaml                   ← SAM template (Lambda + API Gateway + DynamoDB)
├── tsconfig.json
├── tsconfig.scripts.json           ← extends tsconfig for local runner
├── src/
│   ├── handlers/
│   │   └── checkout.ts             ← Lambda entry point
│   ├── services/
│   │   ├── pricingService.ts       ← server-side total calculation
│   │   └── paymentService.ts       ← payment capture (mock with production stub)
│   ├── repositories/
│   │   └── orderRepository.ts      ← DynamoDB reads/writes + idempotency logic
│   ├── types/
│   │   └── index.ts                ← all domain types
│   ├── utils/
│   │   ├── logger.ts               ← structured JSON logger
│   │   └── errors.ts               ← typed error classes
│   └── validators/
│       └── cartValidator.ts        ← request validation
├── tests/
│   ├── checkout.test.ts            ← handler tests (AC-07 – AC-14)
│   ├── pricing.test.ts             ← pricing tests (AC-03 – AC-06)
│   ├── cartValidator.test.ts       ← validation tests (AC-01, AC-02, AC-12 – AC-14)
│   ├── paymentService.test.ts      ← payment capture tests
│   └── errors.test.ts              ← error class tests
└── scripts/
    └── local-run.ts                ← runs handler locally against real DynamoDB
```

---

## How it works

```
Client → API Gateway → Lambda (checkout.ts)
                            │
                ┌───────────┼───────────────┐
                ▼           ▼               ▼
          cartValidator  pricingService  orderRepository ── DynamoDB
                                            │
                                      paymentService
```

The handler is a thin orchestrator — it calls each module in order and handles errors, but contains no business logic itself. This keeps each piece independently testable.

---

## Design decisions worth knowing about

**Spec before code.** `SPEC.md` was written first and every function references the section it implements (e.g. `// SPEC.md §4.1`). When a rule changes, the spec is updated first and the diff makes the intent obvious. No one has to reverse-engineer what the code was trying to do.

**Idempotency via DynamoDB conditional writes.** Every request does a `GetItem` on `cartId` first. If an order already exists, the stored response is returned immediately — no processing, no payment. If not, the `PutItem` uses `attribute_not_exists(cartId)` so concurrent requests can't both succeed. On the rare race condition (`ConditionalCheckFailedException`), the handler re-reads and returns the winner's record. A given `cartId` produces at most one order, regardless of how many times the request is retried.

**The server owns the total.** Clients send `unitPrice` per item for display purposes, but the server always recalculates the total from scratch. There's no client-supplied `total` field to manipulate. In production, `unitPrice` would come from an internal catalogue instead; the calculation logic stays the same either way.

**Payment happens after the order is saved.** The order record is written to DynamoDB first, then payment is captured. This means if payment fails, there's a record with status `PAYMENT_FAILED` for support to investigate. It also means if the Lambda crashes after a successful payment but before the status update, the idempotency check catches the retry and prevents a double charge.

**Typed errors drive HTTP responses.** Each failure case has a dedicated error class (`CartEmptyError`, `PaymentFailedError`, etc.) that carries its own `httpStatus` and `code`. The handler catches `CheckoutError` and uses the error's own properties — no `if/else` chains mapping error types to status codes.

---

## Trade-offs

| Decision | Trade-off |
|---|---|
| `cartId` as idempotency key | Simple and stable across retries. Risk: a client could reuse a cartId for a new order. In production, carts should be server-assigned and single-use. |
| No product catalogue | `unitPrice` is validated but not verified against a real price list. Fine for an MVP, but needs a catalogue service lookup before going to production. |
| Flat 10% tax | Jurisdiction-dependent tax is out of scope. Swapping this out means changing one constant and adding a tax service call — the structure supports it. |
| 90-day DynamoDB TTL | Prevents unbounded table growth. Long-term order history would need an archival pipeline. |
| Mock payment service | The production Stripe integration is stubbed in the same file with a clear comment. Switching providers means implementing that block — no structural changes. |
| No API authentication | Out of scope here. A real deployment would add a JWT/Cognito authoriser at the API Gateway layer. |

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ORDERS_TABLE_NAME` | `checkout-orders` | DynamoDB table name (injected by SAM) |
| `AWS_REGION` | `us-east-1` | AWS region for the DynamoDB client |

No secrets are stored in code. Payment gateway keys would be Lambda environment variables sourced from AWS Secrets Manager.

---

## Tests

```bash
npm test
# with coverage report
npx jest --coverage
```

52 tests across 5 files, covering all 14 acceptance criteria from SPEC.md §10. All DynamoDB and payment calls are mocked — no AWS credentials needed.

| File | What it covers |
|---|---|
| `pricing.test.ts` | AC-03 – AC-06 (server-side calculation, tax, discount) |
| `cartValidator.test.ts` | AC-01, AC-02, AC-12 – AC-14 (validation rules) |
| `checkout.test.ts` | AC-07 – AC-11 (idempotency, payment flow, error handling) |
| `paymentService.test.ts` | direct coverage of capturePayment |
| `errors.test.ts` | all error classes |

---

## Running locally against real DynamoDB

You can run the handler directly on your machine against the real AWS DynamoDB table — no Lambda or API Gateway deployment needed:

```bash
ORDERS_TABLE_NAME=checkout-orders-dev npx ts-node \
  --project tsconfig.scripts.json \
  scripts/local-run.ts
```

This runs four scenarios end-to-end: a successful checkout, an idempotent retry, an empty-cart rejection, and a declined payment. After it finishes, verify the items in DynamoDB:

```bash
aws dynamodb scan --table-name checkout-orders-dev \
  --query 'Items[*].{cart:cartId.S,order:orderId.S,status:status.S,total:total.N}'
```

---

## Deployed on AWS

The service is deployed and live. All three AWS services are active:

| Service | Resource |
|---|---|
| API Gateway | `https://fdrjo6ojnj.execute-api.us-east-1.amazonaws.com/dev/checkout` |
| Lambda | `smart-checkout-dev` (us-east-1) |
| DynamoDB | `checkout-orders-dev` (us-east-1) |

To hit the live endpoint:

```bash
curl -X POST https://fdrjo6ojnj.execute-api.us-east-1.amazonaws.com/dev/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "cartId": "cart_test_001",
    "customerId": "cust_001",
    "items": [{ "productId": "p1", "name": "Widget", "quantity": 2, "unitPrice": 25.00 }],
    "paymentMethod": { "type": "card", "token": "tok_visa_test" }
  }'
```

Sending the same request again returns the same `orderId` — idempotency working end-to-end through API Gateway → Lambda → DynamoDB.

To redeploy after changes:

```bash
sam build && sam deploy
```

`template.yaml` provisions the Lambda function, HTTP API Gateway, and DynamoDB table. The SAM esbuild integration bundles `src/handlers/checkout.ts` → `checkout.js` at the artifact root, so the handler is `checkout.handler`. The Lambda execution role grants only `dynamodb:GetItem`, `dynamodb:PutItem`, and `dynamodb:UpdateItem` on the specific table ARN.

---

*See [SPEC.md](./SPEC.md) for the full functional spec and [CLAUDE_USAGE.md](./CLAUDE_USAGE.md) for development notes.*
