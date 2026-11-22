import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { decryptPaymentSecret } from "../paymentCrypto.js";
import { getPool, withTenantTransaction } from "../db.js";
import { notifyInventoryChanged } from "./inventoryEvents.js";
import { issueSalesInvoice } from "../invoices.js";
import { classifyRefundAmount, shouldRestockAfterFullRefund } from "./refundPolicy.js";

type RazorpayWebhook = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string } };
    refund?: { entity?: { id?: string; payment_id?: string; status?: string; amount?: number } };
  };
};

function signatureMatches(raw: Buffer, secret: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export async function registerRazorpayWebhookRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string } }>("/api/v1/webhooks/razorpay/:slug", async (request, reply) => {
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const signature = request.headers["x-razorpay-signature"];
    if (!raw || typeof signature !== "string") {
      return reply.code(400).send({ error: { code: "WEBHOOK_SIGNATURE_REQUIRED", message: "Webhook signature or raw request body is missing." } });
    }
    const event = request.body as RazorpayWebhook;
    const eventType = typeof event?.event === "string" ? event.event : "unknown";
    const paymentEntity = event?.payload?.payment?.entity;
    const refundEntity = event?.payload?.refund?.entity;
    const client = await getPool().connect();
    let tenantId: string;
    let keyId = "";
    let keySecret = "";
    let refundPaymentId: string | null = null;
    try {
      await client.query("BEGIN");
      const tenant = await client.query("SELECT id FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1", [request.params.slug.toLowerCase()]);
      tenantId = tenant.rows[0]?.id as string;
      if (!tenantId) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "STORE_NOT_FOUND", message: "Store not found." } });
      }
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const gateway = await client.query(
        "SELECT key_id, key_secret_ciphertext, webhook_secret_ciphertext, is_enabled FROM payment_gateway_accounts WHERE tenant_id = $1 AND provider = 'razorpay' LIMIT 1",
        [tenantId],
      );
      if (!gateway.rowCount || !gateway.rows[0].is_enabled) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Payment webhook is not configured." } });
      }
      const webhookSecret = decryptPaymentSecret(gateway.rows[0].webhook_secret_ciphertext as string);
      if (!signatureMatches(raw, webhookSecret, signature)) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "Webhook signature verification failed." } });
      }
      keyId = gateway.rows[0].key_id as string;
      keySecret = decryptPaymentSecret(gateway.rows[0].key_secret_ciphertext as string);
      const eventIdHeader = request.headers["x-razorpay-event-id"];
      const eventId = typeof eventIdHeader === "string" && eventIdHeader.length <= 255
        ? eventIdHeader
        : createHash("sha256").update(raw).digest("hex");
      const recorded = await client.query(
        `INSERT INTO payment_webhook_events (tenant_id, provider, provider_event_id, event_type)
         VALUES ($1, 'razorpay', $2, $3)
         ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [tenantId, eventId, eventType],
      );
      if (!recorded.rowCount) {
        await client.query("COMMIT");
        return reply.send({ received: true, duplicate: true });
      }

      if (eventType === "payment.captured" && paymentEntity?.order_id && paymentEntity.id) {
        const payment = await client.query(
          `SELECT id, sales_order_id, amount_paise, status
           FROM payments WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_order_id = $2`,
          [tenantId, paymentEntity.order_id],
        );
        if (payment.rowCount && Number(payment.rows[0].amount_paise) === paymentEntity.amount && paymentEntity.currency === "INR") {
          // Always lock the order before its payment row. The checkout verifier and expiry worker
          // use the same order-first lock order, avoiding payment/order deadlocks.
          const order = await client.query(
            `SELECT id, branch_id, status, payment_status, reservation_expires_at
             FROM sales_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
            [tenantId, payment.rows[0].sales_order_id],
          );
          await client.query(
            "SELECT id FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
            [tenantId, payment.rows[0].id],
          );
          if (order.rowCount && order.rows[0].status === "confirmed" && order.rows[0].payment_status === "paid") {
            // A distinct but repeated captured event must not trigger a second stock deduction or refund.
          } else if (order.rowCount && order.rows[0].status === "pending" && new Date(order.rows[0].reservation_expires_at).getTime() > Date.now()) {
            const items = await client.query("SELECT product_id, quantity FROM sales_order_items WHERE tenant_id = $1 AND order_id = $2", [tenantId, order.rows[0].id]);
            for (const item of items.rows) {
              const stock = await client.query(
                `UPDATE inventory_balances SET on_hand = on_hand - $4, reserved = reserved - $4, updated_at = now()
                 WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND on_hand >= $4 AND reserved >= $4`,
                [tenantId, order.rows[0].branch_id, item.product_id, item.quantity],
              );
              if (!stock.rowCount) throw new Error("Reserved stock is inconsistent for captured payment.");
              await client.query(
                `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
                 VALUES ($1, $2, $3, 'online_sale', $4, 'sales_order', $5, $6)`,
                [tenantId, order.rows[0].branch_id, item.product_id, -item.quantity, order.rows[0].id, `webhook:${paymentEntity.id}:sale:${item.product_id}`],
              );
              await client.query(
                `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
                 VALUES ($1, $2, $3, 'reservation_release', $4, 'sales_order', $5, $6)`,
                [tenantId, order.rows[0].branch_id, item.product_id, -item.quantity, order.rows[0].id, `webhook:${paymentEntity.id}:release:${item.product_id}`],
              );
            }
            await client.query("UPDATE sales_orders SET status = 'confirmed', payment_status = 'paid' WHERE tenant_id = $1 AND id = $2", [tenantId, order.rows[0].id]);
            await issueSalesInvoice(client, tenantId, order.rows[0].id);
            await client.query("UPDATE payments SET status = 'captured', provider_payment_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, payment.rows[0].id, paymentEntity.id]);
            await notifyInventoryChanged(client, { tenantId, branchId: order.rows[0].branch_id, productIds: items.rows.map((item) => item.product_id as string) });
          } else {
            await client.query("UPDATE payments SET status = 'refund_pending', provider_payment_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, payment.rows[0].id, paymentEntity.id]);
            refundPaymentId = paymentEntity.id;
          }
        }
      } else if (eventType === "payment.failed" && paymentEntity?.order_id && paymentEntity.id) {
        const payment = await client.query(
          "SELECT id, sales_order_id FROM payments WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_order_id = $2",
          [tenantId, paymentEntity.order_id],
        );
        if (payment.rowCount) {
          // Keep the global lock order consistent with payment verification and expiry.
          const order = await client.query("SELECT id, branch_id, status FROM sales_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, payment.rows[0].sales_order_id]);
          await client.query("SELECT id FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, payment.rows[0].id]);
          if (order.rowCount && order.rows[0].status === "pending") {
            const items = await client.query("SELECT product_id, quantity FROM sales_order_items WHERE tenant_id = $1 AND order_id = $2", [tenantId, order.rows[0].id]);
            for (const item of items.rows) {
              const stock = await client.query(
                `UPDATE inventory_balances SET reserved = reserved - $4, updated_at = now()
                 WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3 AND reserved >= $4`,
                [tenantId, order.rows[0].branch_id, item.product_id, item.quantity],
              );
              if (!stock.rowCount) throw new Error("Reservation balance is inconsistent after payment failure.");
              await client.query(
                `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key)
                 VALUES ($1, $2, $3, 'reservation_release', $4, 'sales_order', $5, $6)`,
                [tenantId, order.rows[0].branch_id, item.product_id, -item.quantity, order.rows[0].id, `webhook:${paymentEntity.id}:failed:${item.product_id}`],
              );
            }
            await client.query("UPDATE sales_orders SET status = 'cancelled', payment_status = 'failed' WHERE tenant_id = $1 AND id = $2", [tenantId, order.rows[0].id]);
            await client.query("UPDATE payments SET status = 'failed', provider_payment_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, payment.rows[0].id, paymentEntity.id]);
            await notifyInventoryChanged(client, { tenantId, branchId: order.rows[0].branch_id, productIds: items.rows.map((item) => item.product_id as string) });
          }
        }
      } else if (eventType === "refund.failed" && refundEntity?.payment_id) {
        await client.query(
          "UPDATE payments SET status = 'captured', updated_at = now() WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_payment_id = $2 AND status = 'refund_pending'",
          [tenantId, refundEntity.payment_id],
        );
      } else if (eventType === "refund.processed" && refundEntity?.payment_id) {
        const payment = await client.query(
          `SELECT sales_order_id, amount_paise, status
           FROM payments
           WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_payment_id = $2`,
          [tenantId, refundEntity.payment_id],
        );
        if (payment.rowCount) {
          const refundDecision = classifyRefundAmount(refundEntity.amount, Number(payment.rows[0].amount_paise));
          if (refundDecision === "partial") {
            // Partial money refunds do not prove that goods were physically returned.
            // Keep the payment/order state unchanged for manual reconciliation.
            request.log.warn({
              tenantId,
              paymentId: refundEntity.payment_id,
              refundId: refundEntity.id,
              refundAmountPaise: refundEntity.amount,
              paymentAmountPaise: Number(payment.rows[0].amount_paise),
            }, "Partial Razorpay refund received; automatic inventory restock and full-refund transition skipped");
          } else if (refundDecision === "invalid") {
            request.log.error({
              tenantId,
              paymentId: refundEntity.payment_id,
              refundId: refundEntity.id,
              refundAmountPaise: refundEntity.amount,
              paymentAmountPaise: Number(payment.rows[0].amount_paise),
            }, "Razorpay refund amount is missing or inconsistent; manual reconciliation required");
          } else if (payment.rows[0].status === "captured") {
            // Match the payment lifecycle's order-first lock order and make repeated refund
            // events harmless. A fulfilled sale is never restocked by a payment refund alone.
            const order = await client.query(
              "SELECT id, branch_id, status FROM sales_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
              [tenantId, payment.rows[0].sales_order_id],
            );
            await client.query(
              "SELECT id FROM payments WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_payment_id = $2 FOR UPDATE",
              [tenantId, refundEntity.payment_id],
            );
            if (order.rowCount) {
              if (shouldRestockAfterFullRefund(order.rows[0].status)) {
                const items = await client.query(
                  "SELECT product_id, quantity FROM sales_order_items WHERE tenant_id = $1 AND order_id = $2",
                  [tenantId, order.rows[0].id],
                );
                for (const item of items.rows) {
                  await client.query(
                    `UPDATE inventory_balances SET on_hand = on_hand + $4, updated_at = now()
                     WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3`,
                    [tenantId, order.rows[0].branch_id, item.product_id, item.quantity],
                  );
                  await client.query(
                    `INSERT INTO inventory_movements (tenant_id, branch_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key, notes)
                     VALUES ($1, $2, $3, 'return', $4, 'sales_order', $5, $6, 'Automatic restock after full refund of unfulfilled order')
                     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
                    [tenantId, order.rows[0].branch_id, item.product_id, item.quantity, order.rows[0].id, `refund:${refundEntity.id ?? refundEntity.payment_id}:restock:${item.product_id}`],
                  );
                }
                await notifyInventoryChanged(client, {
                  tenantId,
                  branchId: order.rows[0].branch_id,
                  productIds: items.rows.map((item) => item.product_id as string),
                });
                await client.query(
                  "UPDATE sales_orders SET status = 'refunded', payment_status = 'refunded' WHERE tenant_id = $1 AND id = $2",
                  [tenantId, order.rows[0].id],
                );
              } else {
                // Money was refunded after fulfilment; preserve the fulfilment and stock ledger.
                await client.query(
                  "UPDATE sales_orders SET payment_status = 'refunded' WHERE tenant_id = $1 AND id = $2",
                  [tenantId, order.rows[0].id],
                );
              }
              await client.query(
                "UPDATE payments SET status = 'refunded', updated_at = now() WHERE tenant_id = $1 AND provider_payment_id = $2",
                [tenantId, refundEntity.payment_id],
              );
            }
          }
        }
      }
      await client.query("UPDATE payment_webhook_events SET processed_at = now() WHERE tenant_id = $1 AND provider = 'razorpay' AND provider_event_id = $2", [tenantId, typeof request.headers["x-razorpay-event-id"] === "string" ? request.headers["x-razorpay-event-id"] : createHash("sha256").update(raw).digest("hex")]);
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

    if (refundPaymentId) {
      await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(refundPaymentId)}/refund`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64"), "Content-Type": "application/json" },
        body: JSON.stringify({ notes: { reason: "Stock reservation expired before captured payment webhook" } }),
      });
    }
    return reply.send({ received: true });
  });
}
