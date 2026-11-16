import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireTenantActor } from "../auth.js";
import { decryptPaymentSecret, encryptPaymentSecret } from "../paymentCrypto.js";
import { getPool, withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";

type GatewayConfigBody = { keyId?: string; keySecret?: string; webhookSecret?: string; mode?: "test" | "live" };
type StartPaymentBody = { trackingToken?: string };
type VerifyPaymentBody = { trackingToken?: string; razorpayOrderId?: string; razorpayPaymentId?: string; razorpaySignature?: string };

function amountToPaise(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid order amount.");
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Order amount is too large.");
  return Number(paise);
}
function safeEqualHex(expected: string, received: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(received) || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}
function basicAuth(keyId: string, keySecret: string): string {
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

export async function registerPaymentRoutes(app: FastifyInstance) {
  app.get("/api/v1/business/payments/razorpay", async (request) => {
    const actor = await requireTenantActor(request);
    return withTenantTransaction(actor.tenantId, async (client) => {
      const result = await client.query(
        `SELECT key_id AS "keyId", mode, is_enabled AS "isEnabled"
         FROM payment_gateway_accounts WHERE tenant_id = $1 AND provider = 'razorpay' LIMIT 1`,
        [actor.tenantId],
      );
      return { razorpay: result.rows[0] ?? null };
    });
  });

  app.put<{ Body: GatewayConfigBody }>("/api/v1/business/payments/razorpay", async (request, reply) => {
    const actor = await requireTenantActor(request, ["owner", "admin"]);
    const body = request.body ?? {};
    const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
    const keySecret = typeof body.keySecret === "string" ? body.keySecret.trim() : "";
    const webhookSecret = typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";
    const mode = body.mode;
    if (!keyId || !keySecret || !webhookSecret || (mode !== "test" && mode !== "live") ||
        (mode === "test" && !keyId.startsWith("rzp_test_")) || (mode === "live" && !keyId.startsWith("rzp_live_")) ||
        keySecret.length < 10 || webhookSecret.length < 10) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Provide matching Razorpay test/live Key ID, Key Secret and Webhook Secret." } });
    }
    try {
      const account = await withTenantTransaction(actor.tenantId, async (client) => {
        const result = await client.query(
          `INSERT INTO payment_gateway_accounts
           (tenant_id, provider, key_id, key_secret_ciphertext, webhook_secret_ciphertext, mode, is_enabled)
           VALUES ($1, 'razorpay', $2, $3, $4, $5, true)
           ON CONFLICT (tenant_id) DO UPDATE SET key_id = EXCLUDED.key_id,
             key_secret_ciphertext = EXCLUDED.key_secret_ciphertext,
             webhook_secret_ciphertext = EXCLUDED.webhook_secret_ciphertext,
             mode = EXCLUDED.mode, is_enabled = true, updated_at = now()
           RETURNING key_id AS "keyId", mode, is_enabled AS "isEnabled"`,
          [actor.tenantId, keyId, encryptPaymentSecret(keySecret), encryptPaymentSecret(webhookSecret), mode],
        );
        return result.rows[0];
      });
      return { razorpay: account };
    } catch (error) {
      if (error instanceof Error && error.message.includes("PAYMENT_ENCRYPTION_KEY")) {
        return reply.code(503).send({ error: { code: "PAYMENT_ENCRYPTION_NOT_CONFIGURED", message: "Payment credentials cannot be stored until the server encryption key is configured." } });
      }
      throw error;
    }
  });

  app.post<{ Params: { slug: string; orderId: string }; Body: StartPaymentBody }>("/api/v1/storefront/:slug/orders/:orderId/payment", async (request, reply) => {
    const token = request.body?.trackingToken;
    if (!token || token.length < 32 || token.length > 128) {
      return reply.code(400).send({ error: { code: "TRACKING_TOKEN_REQUIRED", message: "Order tracking token is required." } });
    }
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const client = await getPool().connect();
    let tenantId: string;
    let order: { id: string; orderNumber: string; grandTotal: string; reservationExpiresAt: Date };
    let keyId: string;
    let keySecret: string;
    try {
      await client.query("BEGIN");
      const tenant = await client.query("SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1", [request.params.slug.toLowerCase()]);
      tenantId = tenant.rows[0]?.id as string;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "Store not found." } });
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query(
        `SELECT id, order_number AS "orderNumber", grand_total::text AS "grandTotal",
                reservation_expires_at AS "reservationExpiresAt"
         FROM sales_orders WHERE tenant_id = $1 AND id = $2 AND public_tracking_token_hash = $3
           AND channel = 'online' AND status = 'pending' AND payment_status = 'pending'
           AND reservation_expires_at > now() LIMIT 1`,
        [tenantId, request.params.orderId, tokenHash],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "ORDER_NOT_PAYABLE", message: "Order is expired, already paid or unavailable." } });
      }
      order = result.rows[0];
      const gateway = await client.query(
        "SELECT key_id, key_secret_ciphertext, is_enabled FROM payment_gateway_accounts WHERE tenant_id = $1 AND provider = 'razorpay' LIMIT 1",
        [tenantId],
      );
      if (!gateway.rowCount || !gateway.rows[0].is_enabled) {
        await client.query("ROLLBACK");
        return reply.code(503).send({ error: { code: "PAYMENTS_NOT_CONFIGURED", message: "This store has not connected its payment account." } });
      }
      keyId = gateway.rows[0].key_id as string;
      keySecret = decryptPaymentSecret(gateway.rows[0].key_secret_ciphertext as string);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message.includes("PAYMENT_ENCRYPTION_KEY")) {
        return reply.code(503).send({ error: { code: "PAYMENT_ENCRYPTION_NOT_CONFIGURED", message: "Payment encryption is not configured." } });
      }
      throw error;
    } finally {
      client.release();
    }

    const amount = amountToPaise(order.grandTotal);
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: basicAuth(keyId!, keySecret!), "Content-Type": "application/json" },
      body: JSON.stringify({ amount, currency: "INR", receipt: order.orderNumber, notes: { usms_order_id: order.id, usms_tenant_id: tenantId! } }),
    });
    const gatewayOrder = await response.json() as { id?: string; amount?: number; currency?: string; status?: string; error?: { description?: string } };
    if (!response.ok || !gatewayOrder.id || gatewayOrder.amount !== amount || gatewayOrder.currency !== "INR") {
      request.log.error({ status: response.status, error: gatewayOrder.error?.description }, "Razorpay order creation failed");
      return reply.code(502).send({ error: { code: "PAYMENT_ORDER_FAILED", message: "Payment provider could not start checkout. Your stock reservation will expire automatically." } });
    }
    await withTenantTransaction(tenantId!, async (db) => {
      await db.query(
        `INSERT INTO payments (tenant_id, sales_order_id, provider, provider_order_id, amount_paise, currency, status, idempotency_key)
         VALUES ($1, $2, 'razorpay', $3, $4, 'INR', 'created', $5)
         ON CONFLICT (tenant_id, sales_order_id) DO UPDATE SET provider_order_id = EXCLUDED.provider_order_id,
           amount_paise = EXCLUDED.amount_paise, status = 'created', updated_at = now()`,
        [tenantId, order.id, gatewayOrder.id, amount, `razorpay-order:${order.id}`],
      );
    });
    return { payment: { provider: "razorpay", keyId: keyId!, orderId: gatewayOrder.id, amount, currency: "INR" } };
  });

  app.post<{ Params: { slug: string; orderId: string }; Body: VerifyPaymentBody }>("/api/v1/storefront/:slug/orders/:orderId/verify-payment", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.trackingToken || !body.razorpayOrderId || !body.razorpayPaymentId || !body.razorpaySignature) {
      return reply.code(400).send({ error: { code: "PAYMENT_DETAILS_REQUIRED", message: "Payment callback details are incomplete." } });
    }
    const tokenHash = createHash("sha256").update(body.trackingToken).digest("hex");
    const client = await getPool().connect();
    let tenantId: string;
    let keyId: string;
    let keySecret: string;
    let order: { id: string; branch_id: string; status: string; payment_status: string; reservation_expires_at: Date; grand_total: string };
    try {
      await client.query("BEGIN");
      const tenant = await client.query("SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1", [request.params.slug.toLowerCase()]);
      tenantId = tenant.rows[0]?.id as string;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "Store not found." } });
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query(
        `SELECT id, branch_id, status, payment_status, reservation_expires_at, grand_total::text
         FROM sales_orders WHERE tenant_id = $1 AND id = $2 AND public_tracking_token_hash = $3 LIMIT 1`,
        [tenantId, request.params.orderId, tokenHash],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found." } });
      }
      order = result.rows[0];
      const gateway = await client.query("SELECT key_id, key_secret_ciphertext FROM payment_gateway_accounts WHERE tenant_id = $1 AND provider = 'razorpay' AND is_enabled = true LIMIT 1", [tenantId]);
      if (!gateway.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(503).send({ error: { code: "PAYMENTS_NOT_CONFIGURED", message: "Payment account is unavailable." } });
      }
      keyId = gateway.rows[0].key_id as string;
      keySecret = decryptPaymentSecret(gateway.rows[0].key_secret_ciphertext as string);
      if (order.status === "confirmed" && order.payment_status === "paid") {
        await client.query("COMMIT");
        return reply.send({ status: "paid", orderId: order.id, message: "Payment was already verified." });
      }
      const payment = await client.query(
        "SELECT id, provider_order_id, amount_paise, status FROM payments WHERE tenant_id = $1 AND sales_order_id = $2 AND provider = 'razorpay' LIMIT 1",
        [tenantId, order.id],
      );
      if (!payment.rowCount || payment.rows[0].provider_order_id !== body.razorpayOrderId) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "PAYMENT_ORDER_MISMATCH", message: "Payment order does not match this USMS order." } });
      }
      const expected = createHash("sha256").update(body.razorpayOrderId + "|" + body.razorpayPaymentId).digest("hex");
      // HMAC-SHA256 is the documented Razorpay Checkout signature construction.
      const signature = createHmac("sha256", keySecret).update(body.razorpayOrderId + "|" + body.razorpayPaymentId).digest("hex");
      if (!safeEqualHex(signature, body.razorpaySignature)) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "INVALID_PAYMENT_SIGNATURE", message: "Payment signature verification failed." } });
      }
      void expected;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && error.message.includes("PAYMENT_ENCRYPTION_KEY")) {
        return reply.code(503).send({ error: { code: "PAYMENT_ENCRYPTION_NOT_CONFIGURED", message: "Payment encryption is not configured." } });
      }
      throw error;
    } finally {
      client.release();
    }

    const auth = basicAuth(keyId!, keySecret!);
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(body.razorpayPaymentId)}`, { headers: { Authorization: auth } });
    const providerPayment = await paymentResponse.json() as { id?: string; order_id?: string; amount?: number; currency?: string; status?: string };
    if (!paymentResponse.ok || providerPayment.order_id !== body.razorpayOrderId ||
        providerPayment.amount !== amountToPaise(order.grand_total) || providerPayment.currency !== "INR" ||
        !["authorized","captured"].includes(providerPayment.status ?? "")) {
      return reply.code(409).send({ error: { code: "PAYMENT_NOT_CONFIRMED", message: "The payment provider has not confirmed the expected payment amount." } });
    }
    if (providerPayment.status === "authorized") {
      const capture = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(body.razorpayPaymentId)}/capture`, {
        method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ amount: providerPayment.amount, currency: "INR" }),
      });
      if (!capture.ok) return reply.code(409).send({ error: { code: "PAYMENT_CAPTURE_PENDING", message: "Payment is authorised but capture is not yet confirmed. Check order status shortly." } });
    }

    const finalized = await withTenantTransaction(tenantId!, async (db) => {
      const locked = await db.query(
        "SELECT status, payment_status, reservation_expires_at FROM sales_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, order.id],
      );
      if (locked.rowCount && locked.rows[0].status === "confirmed" && locked.rows[0].payment_status === "paid") return { expired: false, alreadyPaid: true };
      if (!locked.rowCount || locked.rows[0].status !== "pending" || new Date(locked.rows[0].reservation_expires_at).getTime() <= Date.now()) {
        await db.query("UPDATE payments SET status = 'refund_pending', provider_payment_id = $3, updated_at = now() WHERE tenant_id = $1 AND sales_order_id = $2", [tenantId, order.id, body.razorpayPaymentId]);
        return { expired: true };
      }
      const items = await db.query("SELECT product_id, quantity FROM sales_order_items WHERE tenant_id = $1 AND order_id = $2", [tenantId, order.id]);
      for (const item of items.rows) {
        const update = await db.query(
          `UPDATE inventory_balances SET on_hand = on_hand - $4, reserved = reserved - $4, updated_at = now()
           WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand >= $4 AND reserved >= $4`,
          [tenantId, order.branch_id, item.product_id, item.quantity],
        );
        if (!update.rowCount) throw new Error("Reserved stock changed before payment confirmation.");
        await db.query(
          `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'online_sale', $4, 'sales_order', $5, $6)`,
          [tenantId, order.branch_id, item.product_id, -item.quantity, order.id, `paid:${body.razorpayPaymentId}:sale:${item.product_id}`],
        );
        await db.query(
          `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
           VALUES ($1, $2, $3, 'reservation_release', $4, 'sales_order', $5, $6)`,
          [tenantId, order.branch_id, item.product_id, -item.quantity, order.id, `paid:${body.razorpayPaymentId}:release:${item.product_id}`],
        );
      }
      await db.query("UPDATE sales_orders SET status = 'confirmed', payment_status = 'paid' WHERE tenant_id = $1 AND id = $2", [tenantId, order.id]);
      await db.query("UPDATE payments SET status = 'captured', provider_payment_id = $3, updated_at = now() WHERE tenant_id = $1 AND sales_order_id = $2", [tenantId, order.id, body.razorpayPaymentId]);
      await notifyInventoryChanged(db, { tenantId: tenantId!, branchId: order.branch_id, productIds: items.rows.map((item) => item.product_id as string) });
      return { expired: false, alreadyPaid: false };
    });
    if (finalized.expired) {
      // Payment was captured after the stock reservation expired. Do not fulfil; request a refund.
      await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(body.razorpayPaymentId)}/refund`, {
        method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amountToPaise(order.grand_total), notes: { reason: "USMS stock reservation expired before payment confirmation" } }),
      });
      return reply.code(409).send({ error: { code: "RESERVATION_EXPIRED", message: "The stock reservation expired. A refund request has been sent to the payment provider." } });
    }
    return { status: "paid", orderId: order.id, message: finalized.alreadyPaid ? "Payment was already verified." : "Payment verified and stock committed." };
  });
}
