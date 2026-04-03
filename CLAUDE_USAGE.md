# How I Used Claude

I treated Claude like a senior engineer I could bounce ideas off — useful for drafting structures and catching gaps, but not someone whose output you paste in without reading it carefully. Here's what each phase actually looked like.

---

## Writing the spec first

Before touching any code, I wanted a complete spec written down. I asked Claude to draft it:

> "I need to write a Markdown specification for a serverless checkout service. It must cover: checkout flow with numbered steps, API request/response contract, pricing rules (subtotal, 10% tax, 5% loyalty discount), DynamoDB schema for idempotency, error catalogue with HTTP status codes, edge cases, acceptance criteria table, and security rules. Write it so a new engineer can implement from scratch with no other context."

The draft was a solid starting point. I went through it section by section and adjusted the checkout flow steps to match the task requirements exactly, tightened the error catalogue (some codes and HTTP statuses needed correction), and set up the acceptance criteria IDs so they'd map cleanly to test names later.

---

## TypeScript types

Once the spec was stable, I asked Claude to turn the contract into interfaces:

> "Based on the spec, define TypeScript interfaces for: CheckoutRequest, CartItem, PaymentMethod, PricingBreakdown, Order, and the two response shapes (success and error). Make sure the types are exhaustive and enforce the currency as a literal 'USD' type."

The part I focused on most was the `CheckoutResponse` discriminated union. Getting `success: true / success: false` right is what lets the handler narrow types without casting. I also double-checked that `OrderStatus` covered all three states the handler transitions through — `PENDING`, `CONFIRMED`, and `PAYMENT_FAILED`. A missing status is the kind of subtle bug that shows up at the worst time.

---

## Pricing logic

I gave Claude the exact rules from the spec:

> "Implement `calculatePricing(items: CartItem[]): PricingBreakdown` following these rules: subtotal = sum of (quantity × unitPrice) per item, each line rounded to 2dp before summing; tax = round(subtotal × 0.10, 2); discount = round(subtotal × 0.05, 2) when subtotal >= 100, else 0; total = round(subtotal + tax - discount, 2). Throw PricingError if total <= 0 or total > 999999.99. Use Math.round with EPSILON for financial rounding."

I don't trust anyone on financial rounding without checking the numbers by hand. I worked through several cases manually:
- `2 × 25 = 50 → tax = 5 → total = 55` ✅
- `1 × 33.33 → tax = 3.33 (not 3.333)` ✅
- `1 × 100 → discount = 5 → total = 105` ✅
- `2 × 60 = 120 → discount = 6 → total = 126` ✅

---

## Idempotency design

This was one of the trickier design questions, so I asked Claude to walk me through the DynamoDB pattern before writing any code:

> "Explain how to implement idempotency in DynamoDB for a checkout service where cartId is the key. I need: a GetItem check first, then a PutItem with attribute_not_exists condition, and graceful handling of ConditionalCheckFailedException. Walk me through the race condition scenario and how this pattern handles it."

The key thing I verified was the race condition path — that the handler re-reads from DynamoDB after a `ConditionalCheckFailedException` rather than giving up with a 500. I also confirmed that the `checkoutResponse` blob stored alongside the order record is the exact same object returned to the client, so retries always get identical responses.

---

## The Lambda handler

With all the pieces ready, I asked Claude to wire them together:

> "Write the Lambda handler for POST /checkout. It should: (1) parse + validate the body, (2) check idempotency, (3) calculate server-side pricing, (4) write the order as PENDING with a conditional DynamoDB write, (5) capture payment only after the write succeeds, (6) update status to CONFIRMED, (7) return 201. Use typed error classes so the handler never needs to string-match on error names. Log every significant step with structured JSON."

The thing I was most careful about: payment is called **after** `createOrder`, not before. I traced the call order line by line. I also verified both paths — success (stored response reflects CONFIRMED) and failure (stored response is updated to PAYMENT_FAILED, so a retry after a declined payment returns the right state, not a stale PENDING).

---

## Tests

I gave Claude the acceptance criteria and asked for the Jest tests:

> "Write Jest unit tests for the checkout handler. Mock `orderRepository` and `paymentService` entirely. Cover: AC-07 (idempotent retry returns 200 with same body), AC-08 (createOrder not called on repeat), AC-09 (payment only after order write), AC-10 (402 on payment failure, updateOrderStatus called with PAYMENT_FAILED), AC-11 (201 with correct total on first call)."

I paid close attention to AC-09 — it uses a `callOrder` array to assert that `createOrder` always runs before `capturePayment`. I traced through what would happen if the order was inverted to make sure the test would actually catch a regression rather than passing trivially. I also made sure `buildOrder` uses `jest.requireActual` so the real factory runs in tests, not a stub.

---

## Things I always check myself

A few areas where I don't take Claude's output at face value:

- **Financial rounding** — Floating-point has edge cases that produce plausible-looking but wrong results. I always verify with manual calculations.
- **DynamoDB condition expressions** — `attribute_not_exists(cartId)` is correct for PutItem idempotency. Claude sometimes mixes up PutItem and UpdateItem condition syntax. I checked this against the AWS docs.
- **HTTP status codes** — Easy to get wrong and easy to miss when skimming. I cross-checked every code in the error catalogue myself (e.g., 402 for payment failure, 422 for a pricing invariant violation).
- **Security rules** — I reviewed the spec's security section myself. Claude's suggestions are a useful starting point, not a security audit.
- **Test sequencing** — The `callOrder` assertion for AC-09 is subtle. A test that passes regardless of call order is useless, so I traced it manually.

---

## What I caught in review

Running the full test suite revealed four issues that slipped through the initial draft.

**13 tests were failing** because `.toThrow('CART_EMPTY')` checks the error *message* string, not the error code. `CartEmptyError`'s message is `"The cart must contain at least one item."` — the code lives in a separate property. I fixed all affected assertions to use `.toThrow(CartEmptyError)`, which does an `instanceof` check instead.

**Coverage was below thresholds** (functions 75%, lines 77%, branches 66%) because `capturePayment` was always mocked in checkout tests and never called directly, and `InternalError`/`OrderConflictError` were never instantiated anywhere. I added a `paymentService.test.ts`, an `errors.test.ts`, and DynamoDB-failure branch tests in `checkout.test.ts` to cover those gaps.

**The Lambda handler path was wrong** in `template.yaml`. `Handler: dist/handlers/checkout.handler` assumes `tsc` compiles to `dist/`. SAM esbuild actually outputs `checkout.js` at the artifact root — I confirmed this from `.aws-sam/build/CheckoutFunction/checkout.js`. The correct value is `checkout.handler`.

**The IAM policy was broader than necessary.** `DynamoDBCrudPolicy` grants Delete, Scan, Query, and batch operations the handler never uses. SPEC.md §9.6 requires only Get, Put, and Update, so I replaced it with an inline policy scoped to the specific table ARN.

---

## Verifying the live AWS services

After deployment, I asked Claude to run end-to-end tests against the real API Gateway endpoint and verify each AWS service was actually being hit.

Claude ran five requests against `https://fdrjo6ojnj.execute-api.us-east-1.amazonaws.com/dev/checkout` and then checked CloudWatch logs and DynamoDB directly:

**What was tested:**

| Scenario | Expected | Result |
|---|---|---|
| New checkout | 201 CONFIRMED | ✅ Order written to DynamoDB |
| Same `cartId` retry | 200, identical `orderId` | ✅ Idempotent — no second item created |
| Empty cart | 400 CART_EMPTY | ✅ Nothing written to DynamoDB |
| `fail_` token | 402 PAYMENT_FAILED | ✅ Order written with `PAYMENT_FAILED` status |
| Missing `cartId` | 400 INVALID_REQUEST | ✅ Stopped before DynamoDB |

**What the CloudWatch logs confirmed:**

The idempotent retry logged `"Idempotent hit — returning existing order"` and completed in 37ms (vs 554ms for the first request which included a cold start and a DynamoDB write). That timing difference is real evidence the second request hit DynamoDB, found the existing record, and returned immediately without touching payment.

**What I verified myself:**

- Ran `aws dynamodb get-item` on each `cartId` to confirm the exact status written — `CONFIRMED` for the successful order, `PAYMENT_FAILED` for the declined one, and nothing at all for the empty cart.
- Checked that the `orderId` in the idempotent retry response exactly matched the first response, not just a similar-looking value.
- Confirmed the Lambda `requestId` in CloudWatch matched the `requestId` in the API response, proving Lambda was the function actually invoked (not a cached response from API Gateway).

---

*Written alongside [SPEC.md](./SPEC.md) as part of the Markdown-first development process.*
