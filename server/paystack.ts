import type express from "express";
import crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { requireFirebaseAuth } from "./quota";
import { loadAdminConfig, saveAdminConfig, maskSecret } from "./adminConfig";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

function getPaystackConfig() {
  const stored = loadAdminConfig();
  return {
    secretKey: stored.paystackSecretKey || process.env.PAYSTACK_SECRET_KEY || null,
    publicKey: stored.paystackPublicKey || process.env.PAYSTACK_PUBLIC_KEY || null,
    planCode: stored.paystackPlanCode || process.env.PAYSTACK_PLAN_CODE || null,
  };
}

async function resolveUidForEvent(data: any): Promise<string | null> {
  const metadataUid = data?.metadata?.uid;
  if (typeof metadataUid === "string" && metadataUid) return metadataUid;

  const email = data?.customer?.email;
  if (!email) return null;
  try {
    const user = await adminAuth.getUserByEmail(email);
    return user.uid;
  } catch {
    return null;
  }
}

async function activateSubscription(uid: string, fields: { paystackCustomerCode?: string; currentPeriodEnd?: Timestamp | null } = {}) {
  await adminDb.collection("users").doc(uid).set(
    {
      subscriptionStatus: "active",
      cycleTokensUsed: 0,
      updatedAt: FieldValue.serverTimestamp(),
      ...fields,
    },
    { merge: true }
  );
}

function periodEndFromEventData(data: any): Timestamp | null {
  const raw = data?.next_payment_date || data?.subscription?.next_payment_date;
  if (!raw) return null;
  const date = new Date(raw);
  if (isNaN(date.getTime())) return null;
  return Timestamp.fromDate(date);
}

export function registerPaystackRoutes(app: express.Express, requireAdmin: express.RequestHandler) {
  // ---- Admin key/plan management (mirrors the Gemini key admin card) ----
  app.get("/api/admin/paystack-config", requireAdmin, (req, res) => {
    const cfg = getPaystackConfig();
    res.json({
      hasSecretKey: !!cfg.secretKey,
      maskedSecretKey: maskSecret(cfg.secretKey),
      publicKey: cfg.publicKey,
      planCode: cfg.planCode,
    });
  });

  app.post("/api/admin/paystack-config", requireAdmin, async (req, res) => {
    const { secretKey, publicKey, planCode } = req.body || {};
    const patch: Record<string, string> = {};
    if (typeof secretKey === "string" && secretKey.trim()) patch.paystackSecretKey = secretKey.trim();
    if (typeof publicKey === "string" && publicKey.trim()) patch.paystackPublicKey = publicKey.trim();
    if (typeof planCode === "string" && planCode.trim()) patch.paystackPlanCode = planCode.trim();
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "Provide at least one of secretKey, publicKey, planCode." });
    }
    const { durable } = await saveAdminConfig(patch);
    console.log(`Paystack config updated via admin page (${durable ? "durable" : "local-only"}).`);
    const cfg = getPaystackConfig();
    res.json({ success: true, hasSecretKey: !!cfg.secretKey, maskedSecretKey: maskSecret(cfg.secretKey), publicKey: cfg.publicKey, planCode: cfg.planCode, durable });
  });

  // ---- Public config the main app needs to open the checkout popup ----
  app.get("/api/paystack/public-config", (req, res) => {
    const cfg = getPaystackConfig();
    res.json({
      publicKey: cfg.publicKey,
      planCode: cfg.planCode,
      configured: !!(cfg.publicKey && cfg.planCode && cfg.secretKey),
    });
  });

  // ---- First-charge verification (client calls this right after the popup's success callback) ----
  app.post("/api/paystack/verify", requireFirebaseAuth, async (req, res) => {
    const { reference } = req.body || {};
    if (!reference || typeof reference !== "string") {
      return res.status(400).json({ error: "Transaction reference is required." });
    }
    const cfg = getPaystackConfig();
    if (!cfg.secretKey) {
      return res.status(503).json({ error: "Payments are not configured on the server yet." });
    }

    try {
      const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${cfg.secretKey}` },
      });
      const body: any = await verifyRes.json();
      const data = body?.data;

      if (!verifyRes.ok || !data || data.status !== "success") {
        return res.status(402).json({ error: "Payment was not successful." });
      }
      // Never trust the caller's own req.uid alone — cross-check against what
      // Paystack recorded for this specific transaction, so a copied/replayed
      // reference from someone else's successful payment can't be used to
      // self-activate a subscription on this account.
      if (data.metadata?.uid !== req.uid) {
        return res.status(403).json({ error: "This transaction does not belong to the signed-in account." });
      }
      const planCode = data.plan || data.plan_object?.plan_code;
      if (cfg.planCode && planCode && planCode !== cfg.planCode) {
        return res.status(402).json({ error: "Payment was not for the expected plan." });
      }

      await activateSubscription(req.uid!, {
        paystackCustomerCode: data.customer?.customer_code,
        currentPeriodEnd: periodEndFromEventData(data),
      });

      res.json({ success: true });
    } catch (err: any) {
      console.error("Paystack verify error:", err.message);
      res.status(500).json({ error: "Could not verify payment." });
    }
  });

  // ---- Self-serve cancel (called from the profile menu's "Cancel Subscription") ----
  app.post("/api/paystack/cancel", requireFirebaseAuth, async (req, res) => {
    const cfg = getPaystackConfig();
    if (!cfg.secretKey) {
      return res.status(503).json({ error: "Payments are not configured on the server yet." });
    }

    const snap = await adminDb.collection("users").doc(req.uid!).get();
    const data = snap.data();
    const code = data?.paystackSubscriptionCode;
    const token = data?.paystackEmailToken;
    if (!code || !token) {
      return res.status(400).json({ error: "No active subscription found for this account." });
    }

    try {
      const disableRes = await fetch("https://api.paystack.co/subscription/disable", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ code, token }),
      });
      const body: any = await disableRes.json();
      if (!disableRes.ok || !body?.status) {
        return res.status(502).json({ error: body?.message || "Paystack could not cancel the subscription." });
      }

      // Optimistic local update — the subscription.disable webhook will also
      // confirm this shortly, but reflect it immediately for the UI.
      await adminDb.collection("users").doc(req.uid!).set(
        { subscriptionStatus: "canceled", updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      res.json({ success: true });
    } catch (err: any) {
      console.error("Paystack cancel error:", err.message);
      res.status(500).json({ error: "Could not cancel subscription." });
    }
  });

  // ---- Webhook — Paystack calls this directly, no user auth, signature-verified instead ----
  app.post("/api/paystack/webhook", async (req, res) => {
    const cfg = getPaystackConfig();
    const signature = req.headers["x-paystack-signature"];
    if (!cfg.secretKey || typeof signature !== "string" || !req.rawBody) {
      return res.status(401).json({ error: "Invalid webhook request." });
    }

    const expected = crypto.createHmac("sha512", cfg.secretKey).update(req.rawBody).digest("hex");
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    const valid = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    if (!valid) {
      return res.status(401).json({ error: "Invalid signature." });
    }

    if (!isFirebaseAdminConfigured()) {
      // Signature is valid but we can't act on it yet — ack so Paystack doesn't retry-storm.
      return res.status(200).json({ received: true });
    }

    try {
      const event = req.body;
      const data = event?.data;
      const uid = await resolveUidForEvent(data);

      if (uid) {
        switch (event?.event) {
          case "charge.success": {
            await activateSubscription(uid, {
              paystackCustomerCode: data.customer?.customer_code,
              currentPeriodEnd: periodEndFromEventData(data),
            });
            break;
          }
          case "subscription.create": {
            // email_token is required (alongside the subscription code) to call
            // Paystack's disable-subscription API later — it's only ever sent on
            // this event, so it has to be captured here or self-serve cancel can't work.
            await adminDb.collection("users").doc(uid).set(
              { paystackSubscriptionCode: data.subscription_code, paystackEmailToken: data.email_token, updatedAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
            break;
          }
          case "invoice.payment_failed": {
            await adminDb.collection("users").doc(uid).set(
              { subscriptionStatus: "past_due", updatedAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
            break;
          }
          case "subscription.disable": {
            await adminDb.collection("users").doc(uid).set(
              { subscriptionStatus: "canceled", updatedAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
            break;
          }
          default:
            break;
        }
      } else {
        console.warn(`[Paystack webhook] Could not resolve a uid for event "${event?.event}" — skipping.`);
      }

      res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("Paystack webhook processing error:", err.message);
      // Still 200 — we don't want Paystack retrying an event we've already logged as broken.
      res.status(200).json({ received: true });
    }
  });
}
