# Per-shop Razorpay payment setup

USMS uses a direct-merchant model: each shop connects its own Razorpay merchant account. The payment is collected under that shop's Razorpay account and settles according to that merchant's Razorpay settlement configuration. USMS does not pool shop revenue or operate a shared marketplace payment account.

## Server prerequisites

Set `PAYMENT_ENCRYPTION_KEY` in the API environment to a random 32-byte key represented as exactly 64 hexadecimal characters. Keep it in the deployment secret manager. Losing this key makes previously encrypted merchant credentials unreadable; back it up securely and plan a controlled rotation process.

Also set `DATABASE_URL`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, and `ORDER_TRACKING_SECRET`.

## Shop-owner setup

1. Activate a Razorpay merchant account in the shop's legal/business name.
2. In the Razorpay Dashboard, create **test-mode** API keys.
3. Create a webhook using the exact URL shown in the USMS Business App: `https://<your-api-host>/api/v1/webhooks/razorpay/<shop-slug>`.
4. Configure webhook events `payment.captured`, `payment.failed`, `refund.processed`, and `refund.failed`. Use a strong webhook secret and enter that same secret in USMS.
5. In USMS Business App → Payments, enter the test Key ID, Key Secret, Webhook Secret and select Test mode.
6. Publish the storefront, place a test order and verify successful, failed, duplicate and expired-reservation payment paths.
7. Only after the merchant account is approved and end-to-end tests pass, repeat with live keys and Live mode.

## Security behavior

- Key Secret and Webhook Secret are encrypted with AES-256-GCM before they are stored. The API returns only the public Key ID and connection status.
- Razorpay Checkout is opened with a server-created Razorpay Order. The server verifies the Checkout HMAC signature and checks the provider payment's order, amount, currency and capture status before committing stock.
- Webhooks are verified against the original raw request body using HMAC-SHA256. Event IDs are deduplicated.
- Captured payment events commit reserved stock to sold stock. Failed payments release reservations. A captured payment arriving after its reservation expires is not fulfilled; USMS requests a refund and records the pending state.
- The browser success callback is not trusted as proof of payment. The provider's server-side payment record and signed webhook are used to reconcile state.

## Important launch conditions

- Configure the webhook on the shop's Razorpay Dashboard and ensure the configured URL is reachable over HTTPS.
- Test the webhook delivery and replay behavior before accepting live orders.
- Confirm merchant account eligibility, KYC and enabled payment methods directly with Razorpay.
- Refund processing and settlement reconciliation must be monitored; a refund request is not the same as a completed refund.
- Do not store live credentials in source control, frontend environment variables, screenshots or support tickets.
