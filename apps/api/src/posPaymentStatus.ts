export type PosPaymentMethod = "cash" | "upi" | "card" | "bank_transfer" | "credit";

/** Credit sales are receivables, not settled cash/card/UPI payments. */
export function paymentStatusForPosMethod(method: PosPaymentMethod): "paid" | "pending" {
  return method === "credit" ? "pending" : "paid";
}
