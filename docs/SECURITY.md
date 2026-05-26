# Segurança

Modelo de ameaça: app público pago atrás de CDN/WAF. Não armazenamos dados sensíveis (cartões ficam no Stripe), mas armazenamos e-mails, senhas hashed, e dados pessoais leves (idade, nacionalidade, sexo).

## Camadas

```
Usuário
   │
   │ HTTPS (TLS 1.2+)
   ▼
┌──────────────────────────────────────────────────┐
│ CDN/WAF (BYOR-SEC)                               │
│  • DDoS L7                                       │
│  • Rate limit edge (configurar — ver abaixo)     │
│  • Bot management                                │
│  • Headers de resposta (HSTS, CSP)               │
└──────────────────────────┬───────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────┐
│ Webserver (Apache/Nginx)                         │
│  • HTTPS termination (Let's Encrypt)             │
│  • Server tokens off                              │
│  • Headers básicos (X-Content-Type-Options...)   │
└──────────────────────────┬───────────────────────┘
                           │ proxy /api/*
                           ▼
┌──────────────────────────────────────────────────┐
│ FastAPI (defesa em profundidade)                 │
│  • Bcrypt 12 rounds                              │
│  • Constant-time login (anti-enumeration)        │
│  • Rate limit in-memory por endpoint             │
│  • Cookies HttpOnly + Secure + SameSite=Lax      │
│  • Pydantic validation (tipos + tamanhos)        │
│  • Body size 32KB max                            │
│  • Headers nas respostas (CSP/X-Frame/...)       │
│  • Password policy (10 chars + 2 classes)        │
│  • Anti-abuse trial: per-IP + per-token          │
└──────────────────────────┬───────────────────────┘
                           │
                           ▼
                       SQLite
```

## Senhas

- **Algoritmo:** bcrypt cost factor 12 (`bcrypt.gensalt(rounds=12)`).
- **Política mínima:** 10 caracteres, ≥2 classes de (lower / upper / dígito / símbolo), não na blacklist de senhas comuns.
- **Mudança de senha** revoga todas as outras sessões do usuário (mantém a atual).
- **Login** roda bcrypt **mesmo quando o e-mail não existe** (constant-time) — atacante não consegue enumerar e-mails por timing.

## Sessões

- Token `secrets.token_urlsafe(32)` (43 chars, 256 bits de entropia).
- Persiste no DB: `sessions(token, user_id, created_at, expires_at, user_agent, ip)`.
- Cookie `einb_session`: HttpOnly + Secure + SameSite=Lax + Domain fixado + path `/`, TTL 30 dias.
- `POST /api/auth/logout` deleta o token do DB e remove cookie.
- Purga: `auth.purge_expired_sessions()` disponível, ainda não em cron — pode rodar diário.

## Anti-abuso de trial (cookies + IP)

Detalhe completo em [project_antiabuse](../.claude/memory/) (memória interna). Resumo:

1. **localStorage** marca perguntas vistas (UX rápido).
2. **Backend** verifica cada nova pergunta via `POST /api/trial/check`:
   - Por **anon_token** (cookie HttpOnly `einb_anon`, UUID, 1 ano): max 15 perguntas únicas (vida toda).
   - Por **IP hash** (SHA-256 + salt): max 25 perguntas únicas em 24h.
3. Falha de qualquer um → paywall (mesma mensagem genérica em ambos os casos).
4. **Privacidade:** IPs e UAs nunca armazenados raw — só hash truncado de 32/16 chars.

## Headers de segurança

### Enviados pelo backend (`SecurityHeadersMiddleware` em `security.py`)

```
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
Cache-Control: no-store        ← só em /api/*
Pragma: no-cache               ← só em /api/*
```

### Enviados pelo Apache (`einburgerungstest-le-ssl.conf`)

```
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
X-Frame-Options: SAMEORIGIN
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### Para adicionar no CDN/WAF (recomendado, em rule de response headers)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://api.stripe.com; frame-src https://checkout.stripe.com; form-action 'self' https://checkout.stripe.com; base-uri 'self'; object-src 'none'
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
```

CSP é a mais importante para prevenir XSS / injeção de scripts terceiros. Nosso app não usa `<script>...</script>` inline (só `<script src="...">`), então a regra é compatível.

## Rate limiting

| Camada | Onde | Limite |
|---|---|---|
| Edge (WAF) | BYOR-SEC | A configurar: 60 req/IP/h em `/api/trial/*`, 10 req/IP/15min em `/api/auth/login`, 300 req/IP/min global |
| Backend | `security.enforce_rate_limit()` in-memory | Ver [API.md](API.md#rate-limits) |

Diferença: WAF blokeia ANTES de chegar no backend (poupa CPU); o rate-limit do backend é defesa em profundidade caso uma regra WAF seja afrouxada por engano.

## Stripe

- Chave: **restricted key** (`rk_test_...` / `rk_live_...`), nunca a chave secreta full.
- Permissões mínimas: One-time payments template + Promotion Codes (Read) + Coupons (Read).
- Webhook: assinatura HMAC-SHA256 validada com `STRIPE_WEBHOOK_SECRET`.
- Body raw lido antes de qualquer parsing JSON — exigência do Stripe.
- Idempotência: UNIQUE constraint em `payments.stripe_session_id`.

## Secrets

Ficam em `/home/cloudin/backend-einb/.env` (chmod 600, gitignored). Conteúdo:

```
STRIPE_SECRET_KEY=rk_test_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
ANON_HASH_SALT=<random 32 bytes hex>
IP_DAILY_LIMIT=25
```

Para trocar (test ↔ live), editar arquivo e `docker-compose restart`. Sem rebuild.

## TLS

- HTTPS via Let's Encrypt (certbot), renovação automática via cron padrão do certbot.
- HSTS: max-age 1 ano (`Strict-Transport-Security: max-age=31536000`).
- Recomendado no CDN: TLS 1.3 only (ou 1.2+1.3, sem 1.0/1.1).

## Privacidade & GDPR

- E-mails armazenados em claro (necessário para login).
- Senhas hashed com bcrypt — nunca em claro.
- IPs e UAs **hashed com salt** — não reversíveis.
- Sem fingerprinting de browser (canvas/audio/fonts).
- Sem analytics de terceiros (nenhum Google Analytics, Facebook Pixel, etc.).
- Cookies usados:
  - `einb_session`: estritamente necessário (autenticação).
  - `einb_anon`: anti-fraude (não é tracking pessoal).
- Não exige banner de cookies pelo critério ePrivacy (são cookies estritamente necessários ao serviço solicitado pelo usuário).
- Se adicionar fingerprinting/analytics no futuro: precisa banner de consentimento explícito (GDPR).

## Backups

Ver [OPERATIONS.md](OPERATIONS.md#backups).

## Resposta a incidente

- Comprometimento de senha: `UPDATE sessions SET expires_at = CURRENT_TIMESTAMP WHERE user_id = ?` revoga todas as sessões; usuário re-loga.
- Comprometimento de chave Stripe: revoga na dashboard, gera nova, troca `.env`, `docker-compose restart`.
- DDoS no origin: WAF deve mitigar; se não, `docker-compose down` no backend serve apenas o frontend estático.
