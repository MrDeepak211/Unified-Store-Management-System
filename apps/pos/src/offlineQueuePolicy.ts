export interface QueueTenantScope {
  tenantId?: string;
  status: "pending" | "failed";
}

/** Never submit a locally queued sale unless its original tenant is known and active. */
export function canSyncPendingSale(row: QueueTenantScope, activeTenantId: string): boolean {
  return row.status === "pending" && Boolean(row.tenantId) && row.tenantId === activeTenantId;
}

/** Old queue records have no tenant binding and must be reviewed, never guessed. */
export function isLegacyUnscopedSale(row: QueueTenantScope): boolean {
  return !row.tenantId;
}
