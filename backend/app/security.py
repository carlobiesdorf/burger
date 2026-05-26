"""Security helpers: rate limit, IP extraction, password policy, headers."""
import logging
import time
from collections import defaultdict, deque
from threading import Lock
from typing import Optional

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("einb.security")


# ---------- Rate limit (in-memory, per process) ----------
# Suficiente para um único container. Em multi-instance: Redis.
# Para WAF/CDN na frente: o WAF deve barrar floods grosseiros;
# isto é segunda linha contra ataques abaixo do threshold do WAF.

_buckets: dict[str, deque[float]] = defaultdict(deque)
_lock = Lock()


def rate_limit(key: str, max_hits: int, window_s: int) -> bool:
    """Return True if request allowed, False if over the limit."""
    now = time.monotonic()
    cutoff = now - window_s
    with _lock:
        bucket = _buckets[key]
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= max_hits:
            return False
        bucket.append(now)
        return True


def enforce_rate_limit(request: Request, scope: str, max_hits: int, window_s: int) -> None:
    ip = client_ip(request)
    key = f"{scope}:{ip}"
    if not rate_limit(key, max_hits, window_s):
        logger.warning("rate_limit_block scope=%s ip=%s", scope, ip)
        raise HTTPException(status_code=429, detail="rate_limited")


# ---------- IP extraction ----------
# Apache injeta X-Forwarded-For. Confiamos só no último hop (o último IP da
# lista), que é o que o Apache adicionou — anteriores podem ser forjados pelo cliente.

def client_ip(request: Request) -> str:
    """IP of the immediate hop (Apache/CDN). Used for rate-limiting at the edge."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    if request.client:
        return request.client.host
    return "0.0.0.0"


def visitor_ip(request: Request) -> str:
    """IP of the real visitor (front of the chain). Used for per-user abuse counting.

    The CDN/WAF prepends the real client IP to X-Forwarded-For. Order is:
        X-Forwarded-For: <client>, <cdn>, <apache>
    So the FIRST value is the real visitor.

    Defensive: if XFF is missing (direct hit, dev), fall back to client.host.
    """
    # CDN-specific headers take precedence if present (truly trustworthy).
    for header in ("cf-connecting-ip", "true-client-ip", "x-real-ip"):
        v = request.headers.get(header)
        if v:
            return v.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "0.0.0.0"


import hashlib
import os as _os

# Salt for hashing IPs/UAs — change in prod via env. We don't need to store
# raw IPs (GDPR-friendly) but we need a stable hash for counting.
_HASH_SALT = _os.environ.get("ANON_HASH_SALT", "einb-default-salt-change-in-prod").encode("utf-8")


def stable_hash(value: str, length: int = 32) -> str:
    """SHA-256(salt + value), hex-truncated. Privacy-preserving, not reversible."""
    h = hashlib.sha256(_HASH_SALT + (value or "").encode("utf-8")).hexdigest()
    return h[:length]


# ---------- Password policy ----------

# Top senhas comuns vazadas (subset compacto). Bloqueio leve, defesa em camada.
_COMMON_PASSWORDS = {
    "password", "12345678", "123456789", "qwerty123", "qwertyui",
    "password1", "password123", "abc12345", "letmein1", "iloveyou",
    "welcome1", "admin123", "trustno1", "passw0rd", "qwerty12",
    "1q2w3e4r", "zaq12wsx", "monkey12", "dragon12", "master12",
    "hunter22", "shadow12", "qazwsxedc",
}


def password_strong_enough(pw: str) -> Optional[str]:
    """Return None if OK, else a reason string."""
    if len(pw) < 10:
        return "password_too_short"
    if len(pw) > 128:
        return "password_too_long"
    if pw.lower() in _COMMON_PASSWORDS:
        return "password_too_common"
    # Need at least 2 of: lower / upper / digit / symbol
    classes = 0
    if any(c.islower() for c in pw): classes += 1
    if any(c.isupper() for c in pw): classes += 1
    if any(c.isdigit() for c in pw): classes += 1
    if any(not c.isalnum() for c in pw): classes += 1
    if classes < 2:
        return "password_too_simple"
    return None


# ---------- Constant-time dummy hash for login ----------
# Mesmo se o e-mail não existir, rodamos bcrypt contra um hash dummy para
# evitar timing-attack que distingue "usuário inexistente" de "senha errada".
import bcrypt as _bcrypt
_DUMMY_HASH = _bcrypt.hashpw(b"dummy-password-for-timing-equalization",
                              _bcrypt.gensalt(rounds=12)).decode()


def dummy_bcrypt_check(pw: str) -> None:
    try:
        _bcrypt.checkpw(pw.encode("utf-8"), _DUMMY_HASH.encode("utf-8"))
    except Exception:
        pass


# ---------- Body size limit middleware ----------

class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject requests with Content-Length larger than max_bytes.
    Stripe webhook body fica em ~6KB; auth payloads são minúsculos.
    32KB é folga generosa."""

    def __init__(self, app, max_bytes: int = 32 * 1024):
        super().__init__(app)
        self.max_bytes = max_bytes

    async def dispatch(self, request: Request, call_next):
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > self.max_bytes:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "payload_too_large"}, status_code=413)
        return await call_next(request)


# ---------- Security headers middleware ----------

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Defesa em profundidade: também adiciona headers caso o Apache não tenha
    todos. O frontend serve HTML pelo Apache, então o CSP fica lá; aqui só
    proteções básicas das respostas /api."""

    async def dispatch(self, request: Request, call_next):
        resp = await call_next(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=(), payment=()"
        # Cache-Control para respostas /api/: nunca cachear (resposta com cookie / dados privados)
        if request.url.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
            resp.headers["Pragma"] = "no-cache"
        return resp
