"""Admin endpoints. Only users with is_admin=1 can call.

All routes mounted under /api/admin/*.
Pagination: ?page=1&limit=50 (max 200).
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, EmailStr, Field

from . import auth as auth_mod
from . import db as dbmod
from .security import enforce_rate_limit, password_strong_enough

logger = logging.getLogger("einb.admin")

router = APIRouter(prefix="/api/admin", tags=["admin"])


def require_admin(user: dict) -> dict:
    """Wrap require_user — used as dependency below."""
    if not user or not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="admin_required")
    return user


# ---------- schemas ----------

class StatsOut(BaseModel):
    users_total: int
    users_active: int
    users_pending: int
    users_expired: int
    payments_total_count: int
    payments_total_cents: int
    online_now: int  # sessions with last_seen < 5 min
    new_signups_24h: int
    new_payments_24h: int


class UserAdminOut(BaseModel):
    id: int
    email: EmailStr
    age: Optional[int]
    nationality: Optional[str]
    sex: Optional[str]
    land: Optional[str]
    status: str
    coupon_code: Optional[str]
    activated_at: Optional[str]
    expires_at: Optional[str]
    created_at: str
    is_admin: bool


class PaginatedUsers(BaseModel):
    items: list[UserAdminOut]
    total: int
    page: int
    limit: int


class PaymentAdminOut(BaseModel):
    id: int
    user_id: int
    user_email: Optional[str]
    stripe_session_id: Optional[str]
    amount_cents: int
    currency: str
    status: str
    paid_at: Optional[str]
    created_at: str


class PaginatedPayments(BaseModel):
    items: list[PaymentAdminOut]
    total: int
    page: int
    limit: int
    sum_cents: int  # soma só dos status='paid' do filtro atual


class CouponAdminOut(BaseModel):
    code: str
    partner: Optional[str]
    discount_pct: Optional[int]
    discount_cents: Optional[int]
    valid_until: Optional[str]
    max_uses: Optional[int]
    used_count: int
    active: bool
    created_at: str
    signups: int  # quantos usuários se cadastraram com este cupom
    paid: int     # quantos desses pagaram


class CouponCreateIn(BaseModel):
    code: str = Field(min_length=2, max_length=64, pattern=r"^[A-Z0-9_-]+$")
    partner: Optional[str] = Field(default=None, max_length=64)
    discount_pct: Optional[int] = Field(default=None, ge=1, le=99)
    discount_cents: Optional[int] = Field(default=None, ge=1, le=100000)
    valid_days: Optional[int] = Field(default=365, ge=1, le=3650)
    max_uses: Optional[int] = Field(default=None, ge=1)


class CouponPatchIn(BaseModel):
    partner: Optional[str] = None
    discount_pct: Optional[int] = Field(default=None, ge=1, le=99)
    discount_cents: Optional[int] = Field(default=None, ge=1, le=100000)
    valid_days: Optional[int] = Field(default=None, ge=1, le=3650)
    max_uses: Optional[int] = None
    active: Optional[bool] = None


class ResetPasswordIn(BaseModel):
    new_password: str = Field(min_length=10, max_length=128)


class DeleteUserIn(BaseModel):
    admin_password: str = Field(min_length=1, max_length=128)


class RevenueBucket(BaseModel):
    bucket: str       # "2026-05-25" or "2026-W21" or "2026-05"
    revenue_cents: int
    payments_count: int


class SignupBucket(BaseModel):
    bucket: str
    signups: int
    activated: int


# ---------- helpers ----------

def _clamp(page: int, limit: int) -> tuple[int, int]:
    page = max(1, page)
    limit = max(1, min(200, limit))
    return page, limit


# ---------- endpoints ----------

def register(app):
    """Mount admin endpoints on the FastAPI app. Pass main's require_user dependency."""
    from .main import require_user  # circular but fine — main imports admin late

    @router.get("/stats", response_model=StatsOut)
    def admin_stats(user: dict = Depends(require_user)):
        require_admin(user)
        with dbmod.db() as conn:
            now = datetime.now(timezone.utc)
            day_ago = (now - timedelta(days=1)).isoformat()
            five_min = (now - timedelta(minutes=5)).isoformat()

            users = dict(conn.execute("""
                SELECT
                    COUNT(*)                                                     AS total,
                    SUM(CASE WHEN status='active'  THEN 1 ELSE 0 END)            AS active,
                    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END)            AS pending,
                    SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END)            AS expired
                FROM users
            """).fetchone())
            payments = dict(conn.execute("""
                SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS sum_cents
                FROM payments WHERE status='paid'
            """).fetchone())
            online = conn.execute(
                "SELECT COUNT(DISTINCT user_id) FROM sessions WHERE last_seen >= ?",
                (five_min,),
            ).fetchone()[0]
            new_signups = conn.execute(
                "SELECT COUNT(*) FROM users WHERE created_at >= ?",
                (day_ago,),
            ).fetchone()[0]
            new_payments = conn.execute(
                "SELECT COUNT(*) FROM payments WHERE status='paid' AND paid_at >= ?",
                (day_ago,),
            ).fetchone()[0]

        return StatsOut(
            users_total=users["total"] or 0,
            users_active=users["active"] or 0,
            users_pending=users["pending"] or 0,
            users_expired=users["expired"] or 0,
            payments_total_count=payments["n"] or 0,
            payments_total_cents=payments["sum_cents"] or 0,
            online_now=online or 0,
            new_signups_24h=new_signups or 0,
            new_payments_24h=new_payments or 0,
        )

    @router.get("/stats/by-state")
    def admin_stats_by_state(user: dict = Depends(require_user)):
        """Number of users per Bundesland, with split between paid/active and pending."""
        require_admin(user)
        with dbmod.db() as conn:
            rows = conn.execute("""
                SELECT
                    COALESCE(land, '?')                              AS land,
                    COUNT(*)                                          AS total,
                    SUM(CASE WHEN status='active' THEN 1 ELSE 0 END)  AS active,
                    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
                FROM users
                GROUP BY COALESCE(land, '?')
                ORDER BY total DESC
            """).fetchall()
        return [
            {"land": r["land"], "total": r["total"], "active": r["active"] or 0, "pending": r["pending"] or 0}
            for r in rows
        ]

    @router.get("/users/export.csv")
    def admin_users_export(user: dict = Depends(require_user)):
        """Stream all users as CSV. Admin-only. Safe for large lists (uses iter generator)."""
        require_admin(user)
        import csv, io
        from fastapi.responses import StreamingResponse

        def gen():
            buf = io.StringIO()
            w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
            w.writerow([
                "id", "email", "status", "land", "nationality", "age", "sex",
                "coupon_code", "created_at", "activated_at", "expires_at", "is_admin",
            ])
            yield buf.getvalue()
            buf.seek(0); buf.truncate(0)

            with dbmod.db() as conn:
                rows = conn.execute("""
                    SELECT id, email, status, land, nationality, age, sex,
                           coupon_code, created_at, activated_at, expires_at, is_admin
                    FROM users ORDER BY created_at DESC
                """)
                for r in rows:
                    w.writerow([
                        r["id"], r["email"], r["status"], r["land"] or "",
                        r["nationality"] or "", r["age"] if r["age"] is not None else "",
                        r["sex"] or "", r["coupon_code"] or "",
                        r["created_at"], r["activated_at"] or "", r["expires_at"] or "",
                        "1" if r["is_admin"] else "0",
                    ])
                    yield buf.getvalue()
                    buf.seek(0); buf.truncate(0)

        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        return StreamingResponse(
            gen(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="users-{ts}.csv"'},
        )

    @router.get("/users", response_model=PaginatedUsers)
    def admin_users(
        user: dict = Depends(require_user),
        page: int = Query(1, ge=1),
        limit: int = Query(50, ge=1, le=200),
        status: Optional[Literal["active", "pending", "expired"]] = None,
        search: Optional[str] = Query(None, max_length=128),
    ):
        require_admin(user)
        page, limit = _clamp(page, limit)
        offset = (page - 1) * limit

        where = []
        params: list = []
        if status:
            where.append("status = ?"); params.append(status)
        if search:
            where.append("email LIKE ?"); params.append(f"%{search}%")
        where_clause = ("WHERE " + " AND ".join(where)) if where else ""

        with dbmod.db() as conn:
            total = conn.execute(f"SELECT COUNT(*) FROM users {where_clause}", params).fetchone()[0]
            rows = conn.execute(
                f"""SELECT id, email, age, nationality, sex, land, status, coupon_code,
                           activated_at, expires_at, created_at, is_admin
                    FROM users {where_clause}
                    ORDER BY created_at DESC LIMIT ? OFFSET ?""",
                params + [limit, offset],
            ).fetchall()

        items = [
            UserAdminOut(
                id=r["id"], email=r["email"], age=r["age"], nationality=r["nationality"],
                sex=r["sex"], land=r["land"], status=r["status"], coupon_code=r["coupon_code"],
                activated_at=r["activated_at"], expires_at=r["expires_at"],
                created_at=r["created_at"], is_admin=bool(r["is_admin"]),
            ) for r in rows
        ]
        return PaginatedUsers(items=items, total=total, page=page, limit=limit)

    @router.post("/users/{user_id}/reset-password")
    def admin_reset_password(
        user_id: int,
        payload: ResetPasswordIn,
        request: Request,
        user: dict = Depends(require_user),
    ):
        require_admin(user)
        enforce_rate_limit(request, "admin_reset_pw", max_hits=30, window_s=600)

        bad = password_strong_enough(payload.new_password)
        if bad:
            raise HTTPException(status_code=400, detail=bad)

        with dbmod.db() as conn:
            target = conn.execute("SELECT id, email FROM users WHERE id = ?", (user_id,)).fetchone()
            if not target:
                raise HTTPException(status_code=404, detail="user_not_found")
            new_hash = auth_mod.hash_password(payload.new_password)
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user_id))
            # Revoke all sessions of that user — force re-login with new password
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        return {"ok": True, "user_id": user_id, "email": target["email"]}

    @router.delete("/users/{user_id}")
    def admin_delete_user(
        user_id: int,
        payload: DeleteUserIn,
        request: Request,
        user: dict = Depends(require_user),
    ):
        """Hard-delete user + cascade (sessions, progress, payments).
        Requires admin to re-confirm by typing their own password — protects
        against accidental clicks. Admin cannot delete themselves."""
        require_admin(user)
        enforce_rate_limit(request, "admin_delete_user", max_hits=20, window_s=600)

        if user_id == user["id"]:
            raise HTTPException(status_code=400, detail="cannot_delete_self")

        # Re-validate admin's password (defense against XSRF / open tab abuse)
        if not auth_mod.verify_password(payload.admin_password, user["password_hash"]):
            logger.warning("admin_delete_wrong_pw admin_id=%d target=%d", user["id"], user_id)
            raise HTTPException(status_code=401, detail="invalid_admin_password")

        with dbmod.db() as conn:
            target = conn.execute(
                "SELECT id, email FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if not target:
                raise HTTPException(status_code=404, detail="user_not_found")
            # Manual cascade — payments has user_id NOT NULL so we delete them.
            # Sessions and progress have ON DELETE CASCADE but explicit is safer.
            n_pay = conn.execute("DELETE FROM payments WHERE user_id = ?", (user_id,)).rowcount
            n_ses = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,)).rowcount
            n_prog = conn.execute("DELETE FROM progress WHERE user_id = ?", (user_id,)).rowcount
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))

        logger.info("admin_delete_user admin_id=%d deleted_id=%d email=%s payments=%d sessions=%d progress=%d",
                    user["id"], user_id, target["email"], n_pay, n_ses, n_prog)
        return {"ok": True, "deleted_id": user_id, "email": target["email"],
                "cascade": {"payments": n_pay, "sessions": n_ses, "progress": n_prog}}

    @router.get("/payments", response_model=PaginatedPayments)
    def admin_payments(
        user: dict = Depends(require_user),
        page: int = Query(1, ge=1),
        limit: int = Query(50, ge=1, le=200),
        status: Optional[Literal["paid", "pending", "failed", "refunded", "partial_refund"]] = None,
    ):
        require_admin(user)
        page, limit = _clamp(page, limit)
        offset = (page - 1) * limit
        where, params = [], []
        if status:
            where.append("p.status = ?"); params.append(status)
        where_clause = ("WHERE " + " AND ".join(where)) if where else ""

        with dbmod.db() as conn:
            total = conn.execute(f"SELECT COUNT(*) FROM payments p {where_clause}", params).fetchone()[0]
            sum_cents = conn.execute(
                f"""SELECT COALESCE(SUM(amount_cents),0) FROM payments p
                    {where_clause if where_clause else "WHERE 1=1"}
                    {' AND' if where_clause else 'AND'} p.status = 'paid'""",
                params,
            ).fetchone()[0]
            rows = conn.execute(
                f"""SELECT p.id, p.user_id, u.email AS user_email,
                           p.stripe_session_id, p.amount_cents, p.currency,
                           p.status, p.paid_at, p.created_at
                    FROM payments p LEFT JOIN users u ON u.id = p.user_id
                    {where_clause}
                    ORDER BY p.id DESC LIMIT ? OFFSET ?""",
                params + [limit, offset],
            ).fetchall()

        items = [PaymentAdminOut(**dict(r)) for r in rows]
        return PaginatedPayments(items=items, total=total, page=page, limit=limit, sum_cents=sum_cents)

    @router.get("/coupons", response_model=list[CouponAdminOut])
    def admin_list_coupons(user: dict = Depends(require_user)):
        require_admin(user)
        with dbmod.db() as conn:
            rows = conn.execute("""
                SELECT c.code, c.partner, c.discount_pct, c.discount_cents,
                       c.valid_until, c.max_uses, c.used_count, c.active, c.created_at,
                       COALESCE((SELECT COUNT(*) FROM users WHERE coupon_code = c.code), 0) AS signups,
                       COALESCE((SELECT COUNT(*) FROM users WHERE coupon_code = c.code AND status='active'), 0) AS paid
                FROM coupons c ORDER BY c.created_at DESC
            """).fetchall()
        return [
            CouponAdminOut(
                code=r["code"], partner=r["partner"],
                discount_pct=r["discount_pct"], discount_cents=r["discount_cents"],
                valid_until=r["valid_until"], max_uses=r["max_uses"],
                used_count=r["used_count"], active=bool(r["active"]),
                created_at=r["created_at"], signups=r["signups"], paid=r["paid"],
            ) for r in rows
        ]

    @router.post("/coupons", response_model=CouponAdminOut)
    def admin_create_coupon(payload: CouponCreateIn, user: dict = Depends(require_user)):
        require_admin(user)
        if not payload.discount_pct and not payload.discount_cents:
            raise HTTPException(status_code=400, detail="missing_discount")
        valid_until = None
        if payload.valid_days:
            valid_until = (datetime.now(timezone.utc) + timedelta(days=payload.valid_days)).isoformat()
        code = payload.code.upper()
        with dbmod.db() as conn:
            existing = conn.execute("SELECT 1 FROM coupons WHERE code = ?", (code,)).fetchone()
            if existing:
                raise HTTPException(status_code=409, detail="coupon_already_exists")
            conn.execute(
                """INSERT INTO coupons (code, partner, discount_pct, discount_cents,
                                        valid_until, max_uses, used_count, active)
                   VALUES (?, ?, ?, ?, ?, ?, 0, 1)""",
                (code, payload.partner, payload.discount_pct, payload.discount_cents,
                 valid_until, payload.max_uses),
            )
        # re-read to get created_at + counts
        return _get_coupon_or_404(code)

    @router.patch("/coupons/{code}", response_model=CouponAdminOut)
    def admin_patch_coupon(code: str, payload: CouponPatchIn, user: dict = Depends(require_user)):
        require_admin(user)
        code = code.upper()
        fields, params = [], []
        if payload.partner is not None:        fields.append("partner = ?");        params.append(payload.partner)
        if payload.discount_pct is not None:   fields.append("discount_pct = ?");   params.append(payload.discount_pct)
        if payload.discount_cents is not None: fields.append("discount_cents = ?"); params.append(payload.discount_cents)
        if payload.max_uses is not None:       fields.append("max_uses = ?");       params.append(payload.max_uses)
        if payload.active is not None:         fields.append("active = ?");         params.append(1 if payload.active else 0)
        if payload.valid_days is not None:
            v = (datetime.now(timezone.utc) + timedelta(days=payload.valid_days)).isoformat()
            fields.append("valid_until = ?"); params.append(v)
        if not fields:
            raise HTTPException(status_code=400, detail="no_changes")
        params.append(code)
        with dbmod.db() as conn:
            cur = conn.execute(f"UPDATE coupons SET {', '.join(fields)} WHERE code = ?", params)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="coupon_not_found")
        return _get_coupon_or_404(code)

    @router.get("/coupons/{code}/users", response_model=list[UserAdminOut])
    def admin_coupon_users(code: str, user: dict = Depends(require_user)):
        """Lista todos os usuários que se cadastraram usando este cupom."""
        require_admin(user)
        with dbmod.db() as conn:
            rows = conn.execute("""
                SELECT id, email, age, nationality, sex, land, status, coupon_code,
                       activated_at, expires_at, created_at, is_admin
                FROM users WHERE coupon_code = ?
                ORDER BY created_at DESC
            """, (code.upper(),)).fetchall()
        return [
            UserAdminOut(
                id=r["id"], email=r["email"], age=r["age"], nationality=r["nationality"],
                sex=r["sex"], land=r["land"], status=r["status"], coupon_code=r["coupon_code"],
                activated_at=r["activated_at"], expires_at=r["expires_at"],
                created_at=r["created_at"], is_admin=bool(r["is_admin"]),
            ) for r in rows
        ]

    @router.delete("/coupons/{code}")
    def admin_delete_coupon(
        code: str,
        payload: DeleteUserIn,
        request: Request,
        user: dict = Depends(require_user),
    ):
        """Hard-delete cupom. Requires admin password confirmation.
        For non-destructive disable, use PATCH with active=false."""
        require_admin(user)
        enforce_rate_limit(request, "admin_delete_coupon", max_hits=20, window_s=600)

        if not auth_mod.verify_password(payload.admin_password, user["password_hash"]):
            logger.warning("admin_delete_coupon_wrong_pw admin_id=%d code=%s", user["id"], code)
            raise HTTPException(status_code=401, detail="invalid_admin_password")

        code_u = code.upper()
        with dbmod.db() as conn:
            row = conn.execute(
                "SELECT code, used_count FROM coupons WHERE code = ?", (code_u,)
            ).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="coupon_not_found")
            # NOTE: users.coupon_code referenciando este cupom NÃO é FK,
            # então ficam como string órfã (informacional, não quebra nada).
            conn.execute("DELETE FROM coupons WHERE code = ?", (code_u,))

        logger.info("admin_delete_coupon admin_id=%d code=%s had_uses=%d",
                    user["id"], code_u, row["used_count"])
        return {"ok": True, "code": code_u, "had_uses": row["used_count"]}

    @router.get("/charts/revenue", response_model=list[RevenueBucket])
    def admin_chart_revenue(
        user: dict = Depends(require_user),
        period: Literal["day", "week", "month"] = "day",
    ):
        require_admin(user)
        # Daily 30, weekly 12, monthly 12
        if period == "day":
            fmt = "%Y-%m-%d"
            cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        elif period == "week":
            fmt = "%Y-W%W"
            cutoff = (datetime.now(timezone.utc) - timedelta(weeks=12)).isoformat()
        else:  # month
            fmt = "%Y-%m"
            cutoff = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        with dbmod.db() as conn:
            rows = conn.execute(
                f"""SELECT strftime(?, paid_at) AS bucket,
                          COALESCE(SUM(amount_cents),0) AS revenue_cents,
                          COUNT(*) AS payments_count
                   FROM payments
                   WHERE status='paid' AND paid_at >= ?
                   GROUP BY bucket ORDER BY bucket""",
                (fmt, cutoff),
            ).fetchall()
        return [RevenueBucket(bucket=r["bucket"] or "", revenue_cents=r["revenue_cents"],
                              payments_count=r["payments_count"]) for r in rows]

    @router.get("/charts/signups", response_model=list[SignupBucket])
    def admin_chart_signups(user: dict = Depends(require_user)):
        require_admin(user)
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        with dbmod.db() as conn:
            rows = conn.execute("""
                SELECT strftime('%Y-%m-%d', created_at) AS bucket,
                       COUNT(*) AS signups,
                       SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS activated
                FROM users WHERE created_at >= ?
                GROUP BY bucket ORDER BY bucket
            """, (cutoff,)).fetchall()
        return [SignupBucket(bucket=r["bucket"] or "", signups=r["signups"] or 0,
                             activated=r["activated"] or 0) for r in rows]

    app.include_router(router)


def _get_coupon_or_404(code: str) -> CouponAdminOut:
    with dbmod.db() as conn:
        r = conn.execute("""
            SELECT c.code, c.partner, c.discount_pct, c.discount_cents,
                   c.valid_until, c.max_uses, c.used_count, c.active, c.created_at,
                   COALESCE((SELECT COUNT(*) FROM users WHERE coupon_code = c.code), 0) AS signups,
                   COALESCE((SELECT COUNT(*) FROM users WHERE coupon_code = c.code AND status='active'), 0) AS paid
            FROM coupons c WHERE c.code = ?
        """, (code,)).fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="coupon_not_found")
    return CouponAdminOut(
        code=r["code"], partner=r["partner"],
        discount_pct=r["discount_pct"], discount_cents=r["discount_cents"],
        valid_until=r["valid_until"], max_uses=r["max_uses"],
        used_count=r["used_count"], active=bool(r["active"]),
        created_at=r["created_at"], signups=r["signups"], paid=r["paid"],
    )
