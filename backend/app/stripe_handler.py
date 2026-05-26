"""Stripe Checkout + webhook handling.

Activation flow:
    1. user clicks "Pay" in the frontend
    2. POST /api/checkout/create-session
        - validates user is pending (active users get 410)
        - resolves coupon to a Stripe Promotion Code (created on-the-fly if needed)
        - creates Stripe Checkout Session with metadata.user_id
        - returns the redirect URL
    3. user pays on Stripe-hosted page (PayPal / cartão / SEPA)
    4. Stripe POSTs to /api/webhooks/stripe with signature header
        - we verify HMAC, parse event
        - on checkout.session.completed (mode=payment, payment_status=paid):
            - INSERT INTO payments (idempotent on stripe_session_id)
            - UPDATE users SET status='active', activated_at=now, expires_at=+1y
            - increment coupons.used_count if any
"""
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import stripe

from .db import db

logger = logging.getLogger("einb.stripe")

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_PRICE_ID = os.environ.get("STRIPE_PRICE_ID", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
SUBSCRIPTION_DAYS = int(os.environ.get("SUBSCRIPTION_DAYS", "365"))

if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY


class StripeNotConfigured(Exception):
    pass


def _ensure_configured() -> None:
    if not STRIPE_SECRET_KEY or not STRIPE_PRICE_ID:
        raise StripeNotConfigured("stripe_not_configured")


# ---------- promotion code resolution ----------

def _resolve_promotion_code(coupon_code: str) -> Optional[str]:
    """Map our internal coupon to a Stripe Promotion Code.

    Strategy: check if there is already an active Promotion Code in Stripe
    whose code equals our coupon code. If yes, return its id. Otherwise, create
    a Stripe Coupon + Promotion Code on the fly based on our DB row.
    Returns the Promotion Code id (`promo_...`) or None if not applicable.
    """
    if not coupon_code:
        return None

    with db() as conn:
        row = conn.execute(
            """SELECT code, discount_pct, discount_cents, valid_until, active
               FROM coupons WHERE code = ?""",
            (coupon_code,),
        ).fetchone()
    if not row or not row["active"]:
        return None

    # try to find an existing Promotion Code on Stripe
    try:
        existing = stripe.PromotionCode.list(code=coupon_code, active=True, limit=1)
        if existing.data:
            return existing.data[0].id
    except Exception:
        logger.exception("stripe_promo_lookup_failed code=%s", coupon_code)
        return None

    # create Stripe Coupon
    coupon_args: dict = {"duration": "once"}
    if row["discount_pct"]:
        coupon_args["percent_off"] = row["discount_pct"]
    elif row["discount_cents"]:
        coupon_args["amount_off"] = row["discount_cents"]
        coupon_args["currency"] = "eur"
    else:
        return None

    try:
        s_coupon = stripe.Coupon.create(**coupon_args)
        s_promo = stripe.PromotionCode.create(coupon=s_coupon.id, code=coupon_code)
        logger.info("stripe_promo_created code=%s promo_id=%s", coupon_code, s_promo.id)
        return s_promo.id
    except Exception:
        logger.exception("stripe_promo_create_failed code=%s", coupon_code)
        return None


# ---------- checkout session ----------

def create_checkout_session(user: dict, base_url: str) -> str:
    """Returns the Stripe-hosted Checkout URL for this user."""
    _ensure_configured()

    if user["status"] == "active":
        # Already active — frontend should not have asked for this
        raise ValueError("already_active")

    session_args: dict = {
        "mode": "payment",
        "line_items": [{"price": STRIPE_PRICE_ID, "quantity": 1}],
        "success_url": base_url.rstrip("/") + "/?paid=1&session={CHECKOUT_SESSION_ID}",
        "cancel_url": base_url.rstrip("/") + "/?paid=0",
        "customer_email": user["email"],
        "client_reference_id": str(user["id"]),
        "metadata": {
            "einb_user_id": str(user["id"]),
            "einb_coupon": user.get("coupon_code") or "",
        },
        "allow_promotion_codes": True,
        # let Stripe show payment methods enabled in the dashboard (PayPal, card, SEPA…)
    }

    promo_id = None
    if user.get("coupon_code"):
        promo_id = _resolve_promotion_code(user["coupon_code"])
    if promo_id:
        session_args["discounts"] = [{"promotion_code": promo_id}]
        session_args.pop("allow_promotion_codes", None)  # mutually exclusive

    try:
        session = stripe.checkout.Session.create(**session_args)
    except Exception as e:
        logger.exception("stripe_checkout_create_failed uid=%d", user["id"])
        raise

    logger.info("stripe_checkout_created uid=%d session=%s", user["id"], session.id)
    return session.url


# ---------- webhook handling ----------

def verify_and_parse(payload_bytes: bytes, sig_header: str) -> dict:
    """Verify signature and return parsed event dict."""
    if not STRIPE_WEBHOOK_SECRET:
        raise StripeNotConfigured("webhook_secret_not_configured")
    try:
        event = stripe.Webhook.construct_event(
            payload_bytes, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except stripe.error.SignatureVerificationError:
        logger.warning("webhook_bad_signature")
        raise
    return event


def _activate_user(user_id: int, session_id: str, amount_cents: int,
                   currency: str, raw_event: str, coupon_code: Optional[str]) -> bool:
    """Idempotent activation. Returns True if newly activated, False if duplicate."""
    with db() as conn:
        # Idempotency: have we already processed this session?
        existing = conn.execute(
            "SELECT id FROM payments WHERE stripe_session_id = ?", (session_id,)
        ).fetchone()
        if existing:
            logger.info("webhook_duplicate_session sid=%s", session_id)
            return False

        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=SUBSCRIPTION_DAYS)

        conn.execute(
            """INSERT INTO payments
               (user_id, stripe_session_id, amount_cents, currency, status, paid_at, raw_event)
               VALUES (?, ?, ?, ?, 'paid', ?, ?)""",
            (user_id, session_id, amount_cents, currency, now.isoformat(), raw_event),
        )

        conn.execute(
            """UPDATE users SET status = 'active', activated_at = ?, expires_at = ?
               WHERE id = ?""",
            (now.isoformat(), expires.isoformat(), user_id),
        )

        if coupon_code:
            conn.execute(
                "UPDATE coupons SET used_count = used_count + 1 WHERE code = ?",
                (coupon_code,),
            )

    logger.info("user_activated uid=%d expires=%s", user_id, expires.isoformat())
    return True


def handle_event(event: dict) -> dict:
    """Dispatch a parsed Stripe event. Returns a small status dict."""
    etype = event.get("type", "")
    obj = event.get("data", {}).get("object", {})

    if etype == "checkout.session.completed" or etype == "checkout.session.async_payment_succeeded":
        # Payment may be already done (sync, card) or still pending (SEPA).
        # Only activate when payment_status == 'paid'.
        if obj.get("payment_status") != "paid":
            return {"ok": True, "skipped": "not_paid", "etype": etype}

        session_id = obj.get("id")
        amount_total = obj.get("amount_total") or 0
        currency = (obj.get("currency") or "eur").upper()

        # user_id from metadata (preferred) or client_reference_id
        meta = obj.get("metadata") or {}
        uid_str = meta.get("einb_user_id") or obj.get("client_reference_id")
        if not uid_str:
            logger.error("webhook_no_user_id sid=%s", session_id)
            return {"ok": False, "error": "no_user_id"}
        try:
            uid = int(uid_str)
        except ValueError:
            logger.error("webhook_bad_user_id raw=%s", uid_str)
            return {"ok": False, "error": "bad_user_id"}

        coupon = meta.get("einb_coupon") or None

        activated = _activate_user(
            uid, session_id, amount_total, currency,
            json.dumps(event, default=str)[:8000], coupon,
        )
        return {"ok": True, "activated": activated, "uid": uid}

    if etype == "checkout.session.async_payment_failed":
        session_id = obj.get("id")
        logger.warning("webhook_payment_failed sid=%s", session_id)
        return {"ok": True, "logged": "payment_failed"}

    logger.info("webhook_ignored etype=%s", etype)
    return {"ok": True, "ignored": etype}
