export type UUID = string;
export interface ApiError { error: { code: string; message: string; requestId: string } }
export interface TenantContext { tenantId: UUID; membershipId: UUID; role: "owner" | "admin" | "manager" | "staff" | "viewer"; branchIds: UUID[] }
export interface Money { /** Decimal string; never JS floating-point for persisted money. */ amount: string; currency: string }
export interface HealthResponse { status: "ok"; service: string }
