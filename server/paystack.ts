import type express from "express";
import crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminAuth, adminDb, isFirebaseAdminConfigured } from "./firebaseAdmin";
import { requireFirebaseAuth } from "./quota";
import { loadAdminConfig, saveAdminConfig, maskSecret } from "./adminConfig";
import { periodEndFrom, paymentTime, isCurrentSubscription, eventSubscriptionCode, paymentPlanCode, paysForPro } from "./billing";
import { subscriptionStanding, getOrCreateUserDoc } from "./quota";
import { count as countStat } from "./stats";
import { applyFirstMonthPayment, recordCommission, paymentFacts, CreatorError, type PlanPrice } from "./creators";
import { firstMonthOfferUntil, discountedAmount, FIRST_MONTH_KIND, FIRST_MONTH_DISCOUNT_PCT } from "./referrals";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

/** The Paystack secret key, for the admin dashboard's payment history. */
export function paystackSecretKey(): string | null {
  return getPaystackConfig().secretKey;
}

function getPaystackConfig() {
  const stored = loadAdminConfig();
  return {
    secretKey: stored.paystackSecretKey || process.env.PAYSTACK_SECRET_KEY || null,
    publicKey: stored.paystackPublicKey || process.env.PAYSTACK_PUBLIC_KEY || null,
    planCode: stored.paystackPlanCode || process.env.PAYSTACK_PLAN_CODE || null,
    /** PRO paid yearly. Optional: without it the app offers monthly only. */
    yearlyPlanCode: stored.paystackYearlyPlanCode || process.env.PAYSTACK_YEARLY_PLAN_CODE || null,
  };
}

/** The plans a payment for PRO may be for: monthly, and yearly when set. */
function proPlans(cfg: { planCode: string | null; yearlyPlanCode: string | null }): (string | null)[] {
  return [cfg.planCode, cfg.yearlyPlanCode];
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

/**
 * A successful payment (the first, or a renewal): PRO, a fresh monthly
 * allowance, and the date the paid period ends. The period end comes from
 * the payment itself (server/billing.ts), so it is never left blank, which
 * would leave a later cancellation nothing to keep PRO until.
 */
/** The paid plan's interval as the payment gives it ("monthly", "annually"), or null. */
function planIntervalOf(data: any): string | null {
  const v = data?.plan?.interval ?? data?.plan_object?.interval;
  return typeof v === "string" && v ? v.toLowerCase() : null;
}

async function activateSubscription(uid: string, data: any, planCode: string) {
  const now = Date.now();
  await adminDb.collection("users").doc(uid).set(
    {
      subscriptionStatus: "active",
      paystackPlanCode: planCode,
      cycleTokensUsed: 0,
      lastPaymentAt: paymentTime(data, now),
      // A yearly plan's allowance refills monthly from here (server/quota.ts).
      planInterval: planIntervalOf(data),
      cycleStartedAt: paymentTime(data, now),
      cycleMonth: 0,
      currentPeriodEnd: Timestamp.fromMillis(periodEndFrom(data, now)),
      pastDueAt: null,
      ...(data?.customer?.customer_code ? { paystackCustomerCode: data.customer.customer_code } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/** Stop a subscription's future charges. False when Paystack refused. */
async function disableSubscription(secretKey: string, code: string, token: string): Promise<boolean> {
  const res = await fetch("https://api.paystack.co/subscription/disable", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code, token }),
  });
  const body: any = await res.json().catch(() => ({}));
  return res.ok && !!body?.status;
}

// The PRO plan's price as Paystack has it, for the discounted first month.
// Read from Paystack, never from the browser; kept for ten minutes.
const PLAN_TTL_MS = 10 * 60 * 1000;
const planCache = new Map<string, { at: number; price: PlanPrice }>();

async function planPrice(secretKey: string, code: string): Promise<PlanPrice> {
  const hit = planCache.get(code);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.price;
  const res = await fetch(`https://api.paystack.co/plan/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const body: any = await res.json().catch(() => ({}));
  const amount = Number(body?.data?.amount);
  const currency = typeof body?.data?.currency === "string" ? body.data.currency.toUpperCase() : "";
  if (!res.ok || !Number.isFinite(amount) || amount <= 0 || !currency) {
    throw new Error(`Paystack didn't return the PRO plan's price (HTTP ${res.status}).`);
  }
  const price = { code, amount: Math.round(amount), currency };
  planCache.set(code, { at: Date.now(), price });
  return price;
}

/** The normal PRO subscription on a saved card, starting on a future date. */
async function startSubscription(secretKey: string, planCode: string, args: { customer: string; authorization: string; startDate: number }): Promise<boolean> {
  const res = await fetch("https://api.paystack.co/subscription", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: args.customer,
      plan: planCode,
      authorization: args.authorization,
      start_date: new Date(args.startDate).toISOString(),
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.status) {
    console.error(`[Paystack] Starting the subscription after a first month failed (HTTP ${res.status}): ${body?.message || "no message"}`);
    return false;
  }
  return true;
}

/** The discounted first month, from the app's check or the webhook, whichever comes first. */
async function firstMonth(cfg: { secretKey: string | null; planCode: string | null }, uid: string, data: any) {
  if (!cfg.secretKey || !cfg.planCode) throw new CreatorError("Payments are not configured on the server yet.", 503);
  const secretKey = cfg.secretKey;
  const planCode = cfg.planCode;
  const plan = await planPrice(secretKey, planCode);
  const result = await applyFirstMonthPayment(adminDb, uid, data, {
    plan,
    startSubscription: (args) => startSubscription(secretKey, planCode, args),
  }, Date.now());
  // Also when already applied: the commission is keyed by the payment, so a
  // second report only retries one that failed to be written the first time.
  if (result.applied || result.already) await commission(uid, data);
  return result;
}

/** A creator's commission on a PRO payment. Never stops the payment itself from counting. */
async function commission(uid: string, data: any) {
  try {
    const pay = paymentFacts(data, Date.now());
    if (!pay) return;
    const email = typeof data?.customer?.email === "string" ? data.customer.email : null;
    await recordCommission(adminDb, uid, pay, email, Date.now());
  } catch (err: any) {
    console.error(`[Creators] Could not record a commission for uid=${uid}, reference=${data?.reference}:`, err?.message || err);
  }
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
      yearlyPlanCode: cfg.yearlyPlanCode,
    });
  });

  app.post("/api/admin/paystack-config", requireAdmin, async (req, res) => {
    const { secretKey, publicKey, planCode, yearlyPlanCode } = req.body || {};
    const patch: Record<string, string> = {};

    // Shape checks, because a wrong value here fails silently: the config still
    // reads as "configured", checkout still opens, and every call to Paystack
    // then fails for reasons that point nowhere near this field.
    const sk = typeof secretKey === "string" ? secretKey.trim() : "";
    const pk = typeof publicKey === "string" ? publicKey.trim() : "";
    const pl = typeof planCode === "string" ? planCode.trim() : "";
    const yl = typeof yearlyPlanCode === "string" ? yearlyPlanCode.trim() : "";
    if (sk && !/^sk_(test|live)_[A-Za-z0-9]+$/.test(sk)) {
      return res.status(400).json({ error: "That doesn't look like a Paystack secret key — they start with sk_test_ or sk_live_." });
    }
    if (pk && !/^pk_(test|live)_[A-Za-z0-9]+$/.test(pk)) {
      return res.status(400).json({ error: "That doesn't look like a Paystack public key — they start with pk_test_ or pk_live_." });
    }
    if (pl && !/^PLN_[A-Za-z0-9]+$/.test(pl)) {
      return res.status(400).json({ error: "That doesn't look like a Paystack plan code — they start with PLN_." });
    }
    if (yl && !/^PLN_[A-Za-z0-9]+$/.test(yl)) {
      return res.status(400).json({ error: "That doesn't look like a Paystack plan code for the yearly plan — they start with PLN_." });
    }
    if (sk) patch.paystackSecretKey = sk;
    if (pk) patch.paystackPublicKey = pk;
    if (pl) patch.paystackPlanCode = pl;
    if (yl) patch.paystackYearlyPlanCode = yl;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "Provide at least one of secretKey, publicKey, planCode, yearlyPlanCode." });
    }
    const { durable } = await saveAdminConfig(patch);
    console.log(`Paystack config updated via admin page (${durable ? "durable" : "local-only"}).`);
    const cfg = getPaystackConfig();
    res.json({ success: true, hasSecretKey: !!cfg.secretKey, maskedSecretKey: maskSecret(cfg.secretKey), publicKey: cfg.publicKey, planCode: cfg.planCode, yearlyPlanCode: cfg.yearlyPlanCode, durable });
  });

  // ---- Public config the main app needs to open the checkout popup ----
  app.get("/api/paystack/public-config", (req, res) => {
    const cfg = getPaystackConfig();
    res.json({
      publicKey: cfg.publicKey,
      planCode: cfg.planCode,
      yearlyPlanCode: cfg.yearlyPlanCode,
      configured: !!(cfg.publicKey && cfg.planCode && cfg.secretKey),
    });
  });

  // ---- PRO's prices, read from the plans on Paystack, for the Plans page ----
  app.get("/api/paystack/prices", async (_req, res) => {
    const cfg = getPaystackConfig();
    if (!cfg.secretKey || !cfg.planCode) return res.json({ monthly: null, yearly: null });
    const secretKey = cfg.secretKey;
    const read = async (code: string | null) => {
      if (!code) return null;
      try {
        const p = await planPrice(secretKey, code);
        return { amount: p.amount, currency: p.currency };
      } catch (err: any) {
        console.error(`[Paystack] Reading the price of ${code} failed:`, err?.message || err);
        return null;
      }
    };
    const [monthly, yearly] = await Promise.all([read(cfg.planCode), read(cfg.yearlyPlanCode)]);
    res.json({ monthly, yearly });
  });

  // ---- The creator-code offer: the first month at a discount (server/referrals.ts) ----
  // The price comes from the PRO plan on Paystack, so it always matches the
  // check in /verify below; the app only displays it and opens the checkout.
  app.get("/api/billing/offer", requireFirebaseAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const doc = await getOrCreateUserDoc(req.uid!);
    const until = firstMonthOfferUntil(doc, Date.now());
    if (until === null) return res.json({ eligible: false });
    const cfg = getPaystackConfig();
    if (!cfg.secretKey || !cfg.publicKey || !cfg.planCode) return res.json({ eligible: false, configured: false });
    try {
      const plan = await planPrice(cfg.secretKey, cfg.planCode);
      res.json({
        eligible: true,
        until,
        amount: discountedAmount(plan.amount),
        fullAmount: plan.amount,
        currency: plan.currency,
        discountPct: FIRST_MONTH_DISCOUNT_PCT,
        publicKey: cfg.publicKey,
        kind: FIRST_MONTH_KIND,
      });
    } catch (err: any) {
      console.error("[Paystack] Loading the first-month offer failed:", err?.message || err);
      res.status(502).json({ error: "Couldn't load the offer's price. Try again in a moment." });
    }
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
      // The discounted first month a creator code gives (server/creators.ts).
      if (data.metadata?.kind === FIRST_MONTH_KIND) {
        try {
          const result = await firstMonth(cfg, req.uid!, data);
          return res.json({ success: true, firstMonth: true, renews: result.renews, proUntil: result.proUntil });
        } catch (err) {
          if (err instanceof CreatorError) return res.status(err.status).json({ error: err.message });
          throw err;
        }
      }
      // Only a payment for the PRO plan counts (server/billing.ts): a
      // checkout opened for any other amount, with no plan, never does.
      const planCode = paymentPlanCode(data);
      const account = await getOrCreateUserDoc(req.uid!);
      if (!planCode || !paysForPro(planCode, proPlans(cfg), account.paystackPlanCode)) {
        return res.status(402).json({ error: "Payment was not for the expected plan." });
      }

      await activateSubscription(req.uid!, data, planCode);
      await commission(req.uid!, data);

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
      if (!(await disableSubscription(cfg.secretKey, code, token))) {
        return res.status(502).json({ error: "Paystack could not cancel the subscription." });
      }

      // No further charges. PRO itself lasts until the paid period ends
      // (tierOf in server/quota.ts), as the confirmation promised.
      await adminDb.collection("users").doc(req.uid!).set(
        { subscriptionStatus: "canceled", updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      countStat("cancellations");
      const doc = await getOrCreateUserDoc(req.uid!);
      res.json({ success: true, ...subscriptionStanding(doc) });
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
            // The discounted first month (see /verify above).
            if (data?.metadata?.kind === FIRST_MONTH_KIND) {
              try {
                await firstMonth(cfg, uid, data);
              } catch (err: any) {
                console.error(`[Paystack webhook] First-month payment for uid=${uid} not applied: ${err?.message || err}`);
              }
              break;
            }
            // Only a payment for the PRO plan counts (see /verify above).
            const planCode = paymentPlanCode(data);
            const account = await getOrCreateUserDoc(uid);
            if (!planCode || !paysForPro(planCode, proPlans(cfg), account.paystackPlanCode)) {
              console.warn(`[Paystack webhook] charge.success for uid=${uid} ignored: not a payment for the PRO plan (${planCode ?? "no plan"}).`);
              break;
            }
            await activateSubscription(uid, data, planCode);
            await commission(uid, data);
            break;
          }
          case "subscription.create": {
            // email_token is required (alongside the subscription code) to call
            // Paystack's disable-subscription API later — it's only ever sent on
            // this event, so it has to be captured here or self-serve cancel can't work.
            const before = await getOrCreateUserDoc(uid);
            // Only a PRO subscription is recorded. Any other one (an old plan,
            // started with someone else's email address) must not replace, and
            // so stop, the account's real subscription below.
            const subscriptionPlan = paymentPlanCode(data);
            if (!paysForPro(subscriptionPlan, proPlans(cfg), before.paystackPlanCode)) {
              console.warn(`[Paystack webhook] subscription.create for uid=${uid} ignored: not the PRO plan (${subscriptionPlan ?? "no plan"}).`);
              break;
            }
            await adminDb.collection("users").doc(uid).set(
              {
                paystackSubscriptionCode: data.subscription_code,
                paystackEmailToken: data.email_token,
                ...(data.next_payment_date ? { currentPeriodEnd: Timestamp.fromMillis(periodEndFrom(data, Date.now())) } : {}),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            // One subscription per account. Paying again (say, after a failed
            // renewal) starts a new one; the old one would otherwise try the
            // card again next month and charge twice.
            const oldCode = before.paystackSubscriptionCode;
            const oldToken = before.paystackEmailToken;
            if (oldCode && oldToken && oldCode !== data.subscription_code) {
              try {
                if (!(await disableSubscription(cfg.secretKey, oldCode, oldToken))) {
                  console.error(`[Paystack webhook] Could not stop the old subscription ${oldCode} for uid=${uid}.`);
                }
              } catch (err: any) {
                console.error(`[Paystack webhook] Could not stop the old subscription ${oldCode} for uid=${uid}:`, err?.message || err);
              }
            }
            break;
          }
          case "invoice.payment_failed": {
            // A renewal didn't go through: PRO ends with the period already
            // paid for (server/billing.ts), and the subscription is stopped,
            // so Paystack doesn't try the card again next month. Getting PRO
            // back is a new payment from the Plans page.
            const doc = await getOrCreateUserDoc(uid);
            if (!isCurrentSubscription(doc.paystackSubscriptionCode, data)) break;
            if (doc.subscriptionStatus !== "active") break;
            await adminDb.collection("users").doc(uid).set(
              { subscriptionStatus: "past_due", pastDueAt: Date.now(), updatedAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
            countStat("payments_failed");
            if (doc.paystackSubscriptionCode && doc.paystackEmailToken) {
              try {
                if (!(await disableSubscription(cfg.secretKey, doc.paystackSubscriptionCode, doc.paystackEmailToken))) {
                  console.error(`[Paystack webhook] Could not stop subscription ${doc.paystackSubscriptionCode} after a failed payment (uid=${uid}).`);
                }
              } catch (err: any) {
                console.error(`[Paystack webhook] Could not stop subscription ${doc.paystackSubscriptionCode} after a failed payment (uid=${uid}):`, err?.message || err);
              }
            }
            break;
          }
          case "subscription.not_renew":
          case "subscription.disable": {
            // No further charges; PRO lasts until the paid period ends. An
            // older subscription being stopped (see subscription.create) says
            // nothing about the current one.
            const doc = await getOrCreateUserDoc(uid);
            if (!isCurrentSubscription(doc.paystackSubscriptionCode, data)) {
              console.log(`[Paystack webhook] ${event.event} for an older subscription (${eventSubscriptionCode(data)}); account unchanged.`);
              break;
            }
            if (doc.subscriptionStatus === "none") break;
            // Stopped by us after a failed payment (above): it stays a failed
            // payment, not a cancellation.
            if (doc.subscriptionStatus === "past_due") break;
            await adminDb.collection("users").doc(uid).set(
              { subscriptionStatus: "canceled", updatedAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
            // Cancelled from the app, it was counted there already.
            if (doc.subscriptionStatus !== "canceled") countStat("cancellations");
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
