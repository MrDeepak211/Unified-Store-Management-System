export type RefundAmountDecision = "full" | "partial" | "invalid";

/**
 * Razorpay reports refund amounts in paise. Only an exact full refund may
 * trigger the current automatic unfulfilled-order restock path.
 */
export function classifyRefundAmount(refundAmountPaise: unknown, paymentAmountPaise: unknown): RefundAmountDecision {
  if (!Number.isSafeInteger(refundAmountPaise) || !Number.isSafeInteger(paymentAmountPaise)) return "invalid";
  const refundAmount = refundAmountPaise as number;
  const paymentAmount = paymentAmountPaise as number;
  if (refundAmount <= 0 || paymentAmount <= 0 || refundAmount > paymentAmount) return "invalid";
  return refundAmount === paymentAmount ? "full" : "partial";
}

/**
 * A confirmed online order is paid but not yet marked fulfilled. Never put
 * stock back automatically for fulfilled, cancelled or otherwise unknown states.
 */
export function shouldRestockAfterFullRefund(orderStatus: string): boolean {
  return orderStatus === "confirmed";
}
