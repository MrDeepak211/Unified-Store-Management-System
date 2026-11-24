function toCents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Amount must have at most two decimal places.");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}
function toMoney(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}
export function applyCreditCollection(totalAmount: string, alreadyCollected: string, newCollection: string) {
  const total = toCents(totalAmount);
  const collected = toCents(alreadyCollected);
  const received = toCents(newCollection);
  if (total <= 0n || collected < 0n || collected > total || received <= 0n) throw new Error("Invalid credit collection amounts.");
  const outstanding = total - collected;
  if (received > outstanding) throw new Error("Collection exceeds the outstanding balance.");
  const nextCollected = collected + received;
  const nextOutstanding = total - nextCollected;
  return { collectedAmount: toMoney(nextCollected), outstandingAmount: toMoney(nextOutstanding), paymentStatus: nextOutstanding === 0n ? "paid" as const : "pending" as const };
}
