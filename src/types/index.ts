/**
 * Core domain types for the Smart Checkout service.
 * All types trace back to the contract defined in SPEC.md §3.
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export type PaymentMethodType = 'card' | 'wallet';

export interface PaymentMethod {
  type: PaymentMethodType;
  token: string;
}

export interface CheckoutRequest {
  cartId: string;
  customerId: string;
  items: CartItem[];
  paymentMethod: PaymentMethod;
}

// ---------------------------------------------------------------------------
// Pricing  (SPEC.md §4)
// ---------------------------------------------------------------------------

export interface PricingBreakdown {
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  currency: 'USD';
}

// ---------------------------------------------------------------------------
// Order  (SPEC.md §6)
// ---------------------------------------------------------------------------

export type OrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'PAYMENT_FAILED';

export interface Order {
  cartId: string;
  orderId: string;
  customerId: string;
  status: OrderStatus;
  items: CartItem[];
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  currency: 'USD';
  checkoutResponse: CheckoutSuccessResponse;
  createdAt: string;   // ISO-8601
  updatedAt: string;   // ISO-8601
  ttl: number;         // Unix epoch (seconds) for DynamoDB TTL
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface CheckoutSuccessResponse {
  success: true;
  orderId: string;
  cartId: string;
  status: OrderStatus;
  total: number;
  currency: 'USD';
  createdAt: string;
}

export interface CheckoutErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

export type CheckoutResponse = CheckoutSuccessResponse | CheckoutErrorResponse;

// ---------------------------------------------------------------------------
// Errors  (SPEC.md §7)
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'CART_EMPTY'
  | 'PAYMENT_FAILED'
  | 'ORDER_CONFLICT'
  | 'PRICING_ERROR'
  | 'INTERNAL_ERROR';

// ---------------------------------------------------------------------------
// Lambda helpers
// ---------------------------------------------------------------------------

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
