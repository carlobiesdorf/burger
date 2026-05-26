import logging
import os
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import FastAPI, Request, Response, HTTPException, Depends, Cookie
from pydantic import BaseModel, EmailStr, Field, field_validator

from . import auth, db as dbmod, stripe_handler, telegram_notify
from .security import (
    enforce_rate_limit,
    client_ip,
    visitor_ip,
    stable_hash,
    password_strong_enough,
    dummy_bcrypt_check,
    BodySizeLimitMiddleware,
    SecurityHeadersMiddleware,
)
import secrets as _secrets

# ---------- logging ----------
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("einb.api")

# ---------- config ----------
COOKIE_NAME = "einb_session"
ANON_COOKIE_NAME = "einb_anon"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() == "true"
COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN") or None
TRIAL_QUESTIONS = int(os.environ.get("TRIAL_QUESTIONS", "15"))
IP_DAILY_LIMIT = int(os.environ.get("IP_DAILY_LIMIT", "25"))

app = FastAPI(
    title="Einbürgerungstest backend",
    version="0.2.0",
    docs_url=None,        # desabilita /docs em produção; ative localmente se precisar
    redoc_url=None,
    openapi_url=None,
)

app.add_middleware(BodySizeLimitMiddleware, max_bytes=32 * 1024)
app.add_middleware(SecurityHeadersMiddleware)


@app.on_event("startup")
def _startup() -> None:
    dbmod.init_db()
    # Late import to avoid circular dependency
    from . import admin as admin_mod
    admin_mod.register(app)
    logger.info("startup_complete trial_questions=%d", TRIAL_QUESTIONS)


# ---------- schemas ----------

VALID_LAND_CODES = {"BW","BY","BE","BB","HB","HH","HE","MV","NI","NW","RP","SL","SN","ST","SH","TH"}


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    age: int = Field(ge=10, le=120)
    nationality: str = Field(min_length=2, max_length=64)
    sex: Literal["M", "F"]
    land: Optional[str] = Field(default=None, max_length=4)
    coupon_code: Optional[str] = Field(default=None, max_length=64)

    @field_validator("nationality")
    @classmethod
    def trim_nat(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("empty")
        return v


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: int
    email: EmailStr
    age: Optional[int]
    nationality: Optional[str]
    sex: Optional[Literal["M", "F"]]
    land: Optional[str]
    status: str
    coupon_code: Optional[str]
    trial_questions_seen: int
    activated_at: Optional[str]
    expires_at: Optional[str]
    is_admin: bool
    created_at: str


class UpdateLandIn(BaseModel):
    land: str = Field(min_length=2, max_length=4)


class CouponIn(BaseModel):
    code: str = Field(min_length=1, max_length=64)


class CouponOut(BaseModel):
    code: str
    partner: Optional[str]
    discount_pct: Optional[int]
    discount_cents: Optional[int]
    valid_until: Optional[str]


# ---------- helpers ----------

def _set_session_cookie(resp: Response, token: str, expires_at: datetime) -> None:
    resp.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=int((expires_at - datetime.now(timezone.utc)).total_seconds()),
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        domain=COOKIE_DOMAIN,
        path="/",
    )


def _user_dict_to_out(row: dict) -> UserOut:
    return UserOut(
        id=row["id"],
        email=row["email"],
        age=row["age"],
        nationality=row["nationality"],
        sex=row.get("sex"),
        land=row.get("land"),
        status=row["status"],
        coupon_code=row["coupon_code"],
        trial_questions_seen=row["trial_questions_seen"],
        activated_at=row["activated_at"],
        expires_at=row["expires_at"],
        is_admin=bool(row["is_admin"]),
        created_at=row["created_at"],
    )


def current_user(einb_session: Optional[str] = Cookie(default=None)) -> Optional[dict]:
    if not einb_session:
        return None
    return auth.get_user_by_session(einb_session)


def require_user(user: Optional[dict] = Depends(current_user)) -> dict:
    if not user:
        raise HTTPException(status_code=401, detail="not_authenticated")
    return user


def _ua_trim(request: Request) -> str:
    ua = request.headers.get("user-agent", "")
    return ua[:200]


# ---------- routes ----------

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "now": datetime.now(timezone.utc).isoformat(),
        "trial_questions": TRIAL_QUESTIONS,
    }


@app.post("/api/auth/register", response_model=UserOut)
def register(payload: RegisterIn, request: Request, response: Response):
    enforce_rate_limit(request, "register", max_hits=5, window_s=600)

    # Password policy
    bad = password_strong_enough(payload.password)
    if bad:
        raise HTTPException(status_code=400, detail=bad)

    coupon = (payload.coupon_code or "").strip() or None
    if coupon:
        with dbmod.db() as conn:
            row = conn.execute(
                "SELECT code, active, valid_until, max_uses, used_count FROM coupons WHERE code = ?",
                (coupon,),
            ).fetchone()
        if not row or not row["active"]:
            raise HTTPException(status_code=400, detail="invalid_coupon")
        if row["valid_until"] and row["valid_until"] < datetime.now(timezone.utc).isoformat():
            raise HTTPException(status_code=400, detail="expired_coupon")
        if row["max_uses"] is not None and row["used_count"] >= row["max_uses"]:
            raise HTTPException(status_code=400, detail="coupon_exhausted")

    email_norm = str(payload.email).lower().strip()
    pw_hash = auth.hash_password(payload.password)
    land = (payload.land or "").strip().upper() or None
    if land and land not in VALID_LAND_CODES:
        land = None

    try:
        with dbmod.db() as conn:
            cur = conn.execute(
                """INSERT INTO users (email, password_hash, age, nationality, sex, land, coupon_code)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (email_norm, pw_hash, payload.age, payload.nationality, payload.sex, land, coupon),
            )
            uid = cur.lastrowid
            user_row = dict(conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone())
    except Exception as e:
        if "unique" in str(e).lower():
            logger.info("register_duplicate ip=%s", client_ip(request))
            raise HTTPException(status_code=409, detail="email_already_registered")
        logger.exception("register_failed ip=%s", client_ip(request))
        raise HTTPException(status_code=500, detail="server_error")

    token, exp = auth.create_session(uid, _ua_trim(request), client_ip(request))
    _set_session_cookie(response, token, exp)
    logger.info("register_success uid=%d ip=%s", uid, client_ip(request))
    # Fire-and-forget Telegram notification (failures don't block response)
    try:
        telegram_notify.notify_signup(user_row, ip=client_ip(request))
    except Exception:
        logger.exception("telegram_signup_failed uid=%d", uid)
    return _user_dict_to_out(user_row)


@app.post("/api/auth/login", response_model=UserOut)
def login(payload: LoginIn, request: Request, response: Response):
    enforce_rate_limit(request, "login", max_hits=10, window_s=300)

    email_norm = str(payload.email).lower().strip()
    with dbmod.db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email_norm,)).fetchone()

    if not row:
        # Anti-enumeration timing: rodar bcrypt mesmo sem usuário
        dummy_bcrypt_check(payload.password)
        logger.info("login_fail_no_user ip=%s", client_ip(request))
        raise HTTPException(status_code=401, detail="invalid_credentials")

    if not auth.verify_password(payload.password, row["password_hash"]):
        logger.info("login_fail_bad_pw uid=%d ip=%s", row["id"], client_ip(request))
        raise HTTPException(status_code=401, detail="invalid_credentials")

    token, exp = auth.create_session(row["id"], _ua_trim(request), client_ip(request))
    _set_session_cookie(response, token, exp)
    logger.info("login_success uid=%d ip=%s", row["id"], client_ip(request))
    return _user_dict_to_out(dict(row))


@app.get("/api/auth/me", response_model=UserOut)
def me(user: dict = Depends(require_user)):
    return _user_dict_to_out(user)


@app.patch("/api/me/land", response_model=UserOut)
def update_land(payload: UpdateLandIn, user: dict = Depends(require_user)):
    """Persist the user's chosen Bundesland on the server (called by frontend
    when state.land changes for a logged-in user)."""
    code = payload.land.strip().upper()
    if code not in VALID_LAND_CODES:
        raise HTTPException(status_code=400, detail="invalid_land")
    with dbmod.db() as conn:
        conn.execute("UPDATE users SET land = ? WHERE id = ?", (code, user["id"]))
        row = dict(conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())
    return _user_dict_to_out(row)


@app.post("/api/auth/logout")
def logout(response: Response, einb_session: Optional[str] = Cookie(default=None)):
    auth.delete_session(einb_session or "")
    response.delete_cookie(COOKIE_NAME, domain=COOKIE_DOMAIN, path="/")
    return {"ok": True}


# ---------- password change ----------

class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


@app.post("/api/auth/change-password")
def change_password(
    payload: ChangePasswordIn,
    request: Request,
    user: dict = Depends(require_user),
    einb_session: Optional[str] = Cookie(default=None),
):
    enforce_rate_limit(request, "change_pw", max_hits=5, window_s=600)

    if not auth.verify_password(payload.current_password, user["password_hash"]):
        logger.info("change_pw_fail_bad_current uid=%d ip=%s", user["id"], client_ip(request))
        raise HTTPException(status_code=401, detail="invalid_current_password")

    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="password_unchanged")

    bad = password_strong_enough(payload.new_password)
    if bad:
        raise HTTPException(status_code=400, detail=bad)

    new_hash = auth.hash_password(payload.new_password)
    with dbmod.db() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (new_hash, user["id"]),
        )
        # Revoke every OTHER session — current one stays so the user is not logged out
        if einb_session:
            conn.execute(
                "DELETE FROM sessions WHERE user_id = ? AND token != ?",
                (user["id"], einb_session),
            )
        else:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
    logger.info("change_pw_success uid=%d ip=%s", user["id"], client_ip(request))
    return {"ok": True}


# ---------- own payments ----------

class PaymentOut(BaseModel):
    id: int
    stripe_session_id: Optional[str]
    amount_cents: int
    currency: str
    status: str
    paid_at: Optional[str]
    created_at: str


# ---------- contact form ----------

CONTACT_CATEGORIES = {"bug", "problem", "suggestion", "missing_language", "other"}


class ContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    email: EmailStr  # required: Carlos needs to be able to reply
    category: str = Field(min_length=1, max_length=40)
    message: str = Field(min_length=5, max_length=2000)
    # Honeypot: legitimate users leave this empty; bots fill it.
    website: Optional[str] = Field(default="", max_length=200)


@app.post("/api/contact")
def contact_form(payload: ContactIn, request: Request):
    """Public form. Sends message via Telegram (no SMTP needed).
    Rate-limited (per-IP) — generous enough for honest mistakes but
    capped to deter spammers. Honeypot field catches automated bots."""
    enforce_rate_limit(request, "contact", max_hits=15, window_s=3600)

    # Honeypot anti-spam: bots auto-fill all inputs including the hidden `website`
    if payload.website and payload.website.strip():
        logger.info("contact_honeypot_blocked ip=%s", client_ip(request))
        # Return success silently so bots don't know they were caught
        return {"ok": True}

    category = payload.category.strip().lower()
    if category not in CONTACT_CATEGORIES:
        category = "other"

    try:
        telegram_notify.notify_contact(
            name=payload.name.strip(),
            email=str(payload.email).strip(),
            category=category,
            message=payload.message.strip(),
            ip=client_ip(request),
        )
    except Exception:
        logger.exception("telegram_contact_failed")
        # Telegram failed, but contact form is the user's last resort.
        # Don't fail — log and return ok. Admin can check logs.

    return {"ok": True}


@app.get("/api/me/payments", response_model=list[PaymentOut])
def my_payments(user: dict = Depends(require_user)):
    with dbmod.db() as conn:
        rows = conn.execute(
            """SELECT id, stripe_session_id, amount_cents, currency, status, paid_at, created_at
               FROM payments WHERE user_id = ?
               ORDER BY id DESC LIMIT 50""",
            (user["id"],),
        ).fetchall()
    return [PaymentOut(**dict(r)) for r in rows]


# ---------- checkout ----------

class CheckoutOut(BaseModel):
    url: str


@app.post("/api/checkout/create-session", response_model=CheckoutOut)
def create_checkout(request: Request, user: dict = Depends(require_user)):
    enforce_rate_limit(request, "checkout", max_hits=10, window_s=600)

    if user["status"] == "active":
        # Already paid — nothing to do
        raise HTTPException(status_code=410, detail="already_active")

    # Derive base URL. Starlette's request.base_url honours uvicorn's
    # --proxy-headers, so when the Apache proxy sends X-Forwarded-Proto: https
    # we get the public https://einburgerungstest.cloudintrip.com here.
    base_url = str(request.base_url).rstrip("/")
    # Defensive fallback: if Host header missing, refuse rather than send a bad
    # URL to Stripe (would surface as "Not a valid URL").
    if not base_url or "://" not in base_url:
        host = request.headers.get("host", "")
        proto = request.headers.get("x-forwarded-proto", "https")
        if not host:
            raise HTTPException(status_code=500, detail="no_host")
        base_url = f"{proto}://{host}"
    logger.info("checkout_base_url uid=%d url=%s", user["id"], base_url)

    try:
        url = stripe_handler.create_checkout_session(user, base_url)
    except stripe_handler.StripeNotConfigured:
        raise HTTPException(status_code=503, detail="stripe_not_configured")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("checkout_failed uid=%d", user["id"])
        raise HTTPException(status_code=502, detail="checkout_failed")

    return CheckoutOut(url=url)


# ---------- stripe webhook ----------

@app.post("/api/webhooks/stripe")
async def stripe_webhook(request: Request):
    # IMPORTANT: read raw body for signature verification BEFORE any parsing
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")

    try:
        event = stripe_handler.verify_and_parse(payload, sig)
    except stripe_handler.StripeNotConfigured:
        raise HTTPException(status_code=503, detail="webhook_not_configured")
    except Exception:
        # Includes SignatureVerificationError, ValueError on bad JSON, etc.
        logger.warning("webhook_rejected ip=%s", client_ip(request))
        raise HTTPException(status_code=400, detail="invalid_signature")

    try:
        result = stripe_handler.handle_event(event)
    except Exception:
        logger.exception("webhook_handler_error etype=%s", event.get("type"))
        # Returning 500 makes Stripe retry — desired behaviour for transient errors
        raise HTTPException(status_code=500, detail="handler_error")

    return result


# ---------- trial (anti-abuse) ----------

class TrialCheckIn(BaseModel):
    question_id: int = Field(ge=1, le=10000)


class TrialCheckOut(BaseModel):
    allowed: bool
    seen: int
    limit: int
    reason: str  # 'active' | 'pending_payment' | 'already_seen' | 'ok' | 'trial_exhausted'


@app.post("/api/trial/check", response_model=TrialCheckOut)
def trial_check(
    payload: TrialCheckIn,
    request: Request,
    response: Response,
    einb_session: Optional[str] = Cookie(default=None),
    einb_anon: Optional[str] = Cookie(default=None),
):
    """Per-question trial gate. Anonymous users get TRIAL_QUESTIONS per token
    AND at most IP_DAILY_LIMIT per IP per 24h. Logged-in active users always
    pass; pending users get the post-register paywall."""
    enforce_rate_limit(request, "trial_check", max_hits=120, window_s=300)

    # 1. Logged-in user paths
    user = auth.get_user_by_session(einb_session) if einb_session else None
    if user:
        if user["status"] == "active":
            # Optionally check expiry
            exp = user.get("expires_at")
            if exp and exp < datetime.now(timezone.utc).isoformat():
                return TrialCheckOut(allowed=False, seen=0, limit=TRIAL_QUESTIONS, reason="trial_exhausted")
            return TrialCheckOut(allowed=True, seen=0, limit=TRIAL_QUESTIONS, reason="active")
        if user["status"] == "pending":
            return TrialCheckOut(allowed=False, seen=0, limit=TRIAL_QUESTIONS, reason="pending_payment")

    # 2. Anonymous: ensure cookie token
    anon_token = einb_anon
    if not anon_token:
        anon_token = _secrets.token_urlsafe(16)
        response.set_cookie(
            key=ANON_COOKIE_NAME,
            value=anon_token,
            max_age=365 * 24 * 3600,
            httponly=True,
            secure=COOKIE_SECURE,
            samesite="lax",
            domain=COOKIE_DOMAIN,
            path="/",
        )

    # 3. Hash IP + UA (privacy-preserving, not reversible)
    ip = visitor_ip(request)
    ua = (request.headers.get("user-agent") or "")[:200]
    ip_h = stable_hash(ip, 32)
    ua_h = stable_hash(ua, 16)

    with dbmod.db() as conn:
        # Already seen this question with this token? Always OK.
        seen_row = conn.execute(
            "SELECT 1 FROM anon_trial_views WHERE anon_token = ? AND question_id = ?",
            (anon_token, payload.question_id),
        ).fetchone()

        # Total unique questions by this token (lifetime)
        token_count = conn.execute(
            "SELECT COUNT(*) FROM anon_trial_views WHERE anon_token = ?",
            (anon_token,),
        ).fetchone()[0]

        if seen_row:
            return TrialCheckOut(allowed=True, seen=token_count, limit=TRIAL_QUESTIONS, reason="already_seen")

        # Token exhausted?
        if token_count >= TRIAL_QUESTIONS:
            logger.info("trial_block_token token=%s seen=%d", anon_token[:8], token_count)
            return TrialCheckOut(allowed=False, seen=token_count, limit=TRIAL_QUESTIONS, reason="trial_exhausted")

        # IP-level limit in last 24h (deters cookie clearing)
        ip_count = conn.execute(
            """SELECT COUNT(DISTINCT question_id) FROM anon_trial_views
               WHERE ip_hash = ? AND seen_at > datetime('now', '-1 day')""",
            (ip_h,),
        ).fetchone()[0]
        if ip_count >= IP_DAILY_LIMIT:
            logger.info("trial_block_ip ip_hash=%s ip_count=%d", ip_h[:8], ip_count)
            # Same `reason` as token exhaustion — frontend shows the generic paywall
            return TrialCheckOut(allowed=False, seen=token_count, limit=TRIAL_QUESTIONS, reason="trial_exhausted")

        # Insert view (UNIQUE constraint protects against race)
        conn.execute(
            "INSERT OR IGNORE INTO anon_trial_views (anon_token, ip_hash, ua_hash, question_id) VALUES (?, ?, ?, ?)",
            (anon_token, ip_h, ua_h, payload.question_id),
        )

    return TrialCheckOut(allowed=True, seen=token_count + 1, limit=TRIAL_QUESTIONS, reason="ok")


# ---------- coupons ----------

@app.post("/api/coupons/validate", response_model=CouponOut)
def validate_coupon(payload: CouponIn, request: Request):
    enforce_rate_limit(request, "coupon_validate", max_hits=20, window_s=300)

    code = payload.code.strip()
    if not code:
        raise HTTPException(status_code=400, detail="empty_code")
    with dbmod.db() as conn:
        row = conn.execute(
            """SELECT code, partner, discount_pct, discount_cents, valid_until,
                      max_uses, used_count, active
               FROM coupons WHERE code = ?""",
            (code,),
        ).fetchone()
    if not row or not row["active"]:
        raise HTTPException(status_code=404, detail="coupon_not_found")
    if row["valid_until"] and row["valid_until"] < datetime.now(timezone.utc).isoformat():
        raise HTTPException(status_code=400, detail="coupon_expired")
    if row["max_uses"] is not None and row["used_count"] >= row["max_uses"]:
        raise HTTPException(status_code=400, detail="coupon_exhausted")
    return CouponOut(
        code=row["code"],
        partner=row["partner"],
        discount_pct=row["discount_pct"],
        discount_cents=row["discount_cents"],
        valid_until=row["valid_until"],
    )
