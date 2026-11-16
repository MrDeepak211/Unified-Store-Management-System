# Unified Store Management System (USMS)

A multi-tenant retail SaaS platform connecting customer storefronts, offline-capable POS, business operations, and SaaS administration through one shared backend.

## Core principle
Separate user interfaces, shared APIs and business logic, one logical PostgreSQL data platform, strict tenant isolation, and offline-first POS synchronization.

## Apps
- `apps/api` — Fastify API
- `apps/storefront` — customer online store
- `apps/pos` — in-store POS
- `apps/dashboard` — business owner dashboard
- `apps/super-admin` — SaaS platform administration

## Packages
Shared database schema, API contracts, validation, API client, UI, utilities, and sync engine live under `packages/`.

## Status
Initial repository bootstrap. This is a development foundation, not a production-ready financial, GST, or payment system. Review tax workflows with a qualified professional and complete a security review before onboarding real tenants.
