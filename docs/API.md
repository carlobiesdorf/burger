# API REST — `https://einburgerungstest.cloudintrip.com/api`

Base prefixada com `/api`. Todas as respostas são JSON. Erros usam HTTP semântico:

| Código | Significado |
|---|---|
| 200 | OK |
| 400 | Validação (body com `detail` = código de erro, ver tabela abaixo) |
| 401 | Não autenticado / credenciais inválidas |
| 403 | Sem permissão |
| 404 | Não encontrado (cupom, etc.) |
| 409 | Conflito (e-mail já cadastrado) |
| 410 | Recurso já consumido (`already_active`) |
| 413 | Body grande demais (limite 32KB) |
| 422 | Pydantic body inválido (estrutura/tipo) |
| 429 | Rate limit |
| 500/502/503 | Erro interno / dependência fora |

Códigos de erro string (`detail`) padronizados — frontend tem tradução em `i18n/<lang>.json` (chave `errors.<detail>`):

```
invalid_credentials, email_already_registered, password_too_short,
password_too_long, password_too_common, password_too_simple,
password_unchanged, invalid_current_password, rate_limited,
invalid_coupon, coupon_not_found, coupon_expired, coupon_exhausted,
network_error, payload_too_large, empty_code, not_authenticated,
server_error, already_active, stripe_not_configured, checkout_failed,
invalid_signature, no_host, handler_error
```

---

## Autenticação

Baseada em cookie `einb_session` (HttpOnly, Secure, SameSite=Lax, Domain=einburgerungstest.cloudintrip.com, max-age 30 dias).
Cookie é setado por `register` e `login`, removido por `logout`.

### `POST /api/auth/register`

Cria conta nova com status `pending` (precisa pagar para ativar).

**Body:**
```json
{
  "email": "user@example.com",
  "password": "MinhaSenh@10",       // mín. 10 chars + 2 classes (letra/digito/símbolo)
  "age": 33,                         // 10-120
  "nationality": "Brasilianisch",    // 2-64 chars
  "sex": "M",                        // "M" ou "F"
  "coupon_code": "WELCOME10"         // opcional
}
```

**200 OK:** retorna `UserOut` + seta cookie `einb_session`.

**Erros:** `409 email_already_registered`, `400 password_too_short|too_long|too_common|too_simple`, `400 invalid_coupon|expired_coupon|coupon_exhausted`, `429 rate_limited` (max 5 / 10 min por IP).

### `POST /api/auth/login`

Autentica usuário existente. Constant-time comparison anti-enumeration.

**Body:**
```json
{ "email": "user@example.com", "password": "MinhaSenh@10" }
```

**200 OK:** retorna `UserOut` + seta cookie. **401 invalid_credentials** (genérico — não revela se e-mail existe).
**429 rate_limited** após 10 tentativas / 5 min por IP.

### `GET /api/auth/me`

Retorna dados do usuário logado. Requer cookie de sessão válido.

**200 OK:**
```json
{
  "id": 17,
  "email": "user@example.com",
  "age": 33,
  "nationality": "Brasilianisch",
  "sex": "M",
  "status": "active",                  // "pending" | "active" | "expired"
  "coupon_code": null,
  "trial_questions_seen": 0,
  "activated_at": "2026-05-25T20:35:00Z",
  "expires_at": "2027-05-25T20:35:00Z",
  "is_admin": false,
  "created_at": "2026-05-25T20:30:00Z"
}
```

**401 not_authenticated** se cookie ausente/inválido.

### `POST /api/auth/logout`

Invalida a sessão atual e limpa o cookie. Não requer body. Sempre retorna `{"ok": true}`.

### `POST /api/auth/change-password`

Troca senha. Revoga **todas as outras sessões** do usuário (mantém a atual).

**Body:**
```json
{ "current_password": "OldPass99X", "new_password": "NewPass99Y" }
```

**200 OK:** `{"ok": true}`.
**Erros:** `401 invalid_current_password`, `400 password_too_short|...`, `400 password_unchanged`.

---

## Trial (anti-abuso)

### `POST /api/trial/check`

Gate por pergunta. Conta no backend, defesa em profundidade contra reset de cache.
Lógica: por **anon_token** (cookie HttpOnly) + por **IP** (hashed).

**Body:**
```json
{ "question_id": 42 }
```

**200 OK:**
```json
{
  "allowed": true,            // pode mostrar a pergunta?
  "seen": 7,                  // quantas perguntas únicas o token já viu
  "limit": 15,                // limite de trial atual
  "reason": "ok"              // "ok" | "already_seen" | "active" | "pending_payment" | "trial_exhausted"
}
```

**Lógica server-side:**
1. Se usuário **logado active** → `allowed: true, reason: "active"`
2. Se usuário **logado pending** → `allowed: false, reason: "pending_payment"`
3. Se **já viu essa qid** com o token → `allowed: true, reason: "already_seen"` (não desconta)
4. Se **token atingiu 15 únicas** → `allowed: false, reason: "trial_exhausted"`
5. Se **IP atingiu 25 únicas em 24h** → `allowed: false, reason: "trial_exhausted"` (mesma mensagem por design, não vaza a regra)
6. Caso contrário, registra e retorna `allowed: true, reason: "ok"`

**Cookie efeito colateral:** se `einb_anon` não existia, é criado (UUID, 1 ano).
**Rate limit:** 120 req / 5 min por IP (camada de proteção contra automação).

---

## Cupons

### `POST /api/coupons/validate`

Valida cupom sem reservar. Usado pelo formulário de cadastro (live preview do desconto).

**Body:**
```json
{ "code": "WELCOME10" }
```

**200 OK:**
```json
{
  "code": "WELCOME10",
  "partner": "house",
  "discount_pct": 10,
  "discount_cents": null,
  "valid_until": "2027-05-25T17:33:13Z"
}
```

**Erros:** `404 coupon_not_found`, `400 coupon_expired`, `400 coupon_exhausted`, `400 empty_code`.
**Rate limit:** 20 req / 5 min por IP.

---

## Checkout (Stripe)

### `POST /api/checkout/create-session`

Cria Stripe Checkout Session. Requer login. Bloqueado se usuário já é `active` (410).

**Body:** vazio `{}`.

**200 OK:**
```json
{ "url": "https://checkout.stripe.com/c/pay/cs_test_..." }
```

Frontend faz `window.location.href = url` e o usuário paga na página hospedada do Stripe.

**Erros:** `401 not_authenticated`, `410 already_active`, `503 stripe_not_configured`, `502 checkout_failed`.
**Rate limit:** 10 req / 10 min.

**Sobre cupom:** se o usuário se cadastrou com `coupon_code`, esse cupom é resolvido como **Stripe Promotion Code** (criado on-the-fly se não existe) e pré-aplicado na sessão.
**Sobre PayPal:** é um método de pagamento configurado **no painel Stripe** — backend não precisa de nada extra.

---

## Webhook (Stripe → backend)

### `POST /api/webhooks/stripe`

**Não é endpoint público.** Stripe é a única origem legítima. Validação por assinatura HMAC-SHA256 com `STRIPE_WEBHOOK_SECRET`.

**Eventos processados:**

| Evento | Ação |
|---|---|
| `checkout.session.completed` (paid) | Ativa user (`pending`→`active`), seta `expires_at=+1y`, insere row em `payments` com `stripe_payment_intent` salvo |
| `checkout.session.async_payment_succeeded` (paid) | Idem (caso SEPA/atraso) |
| `checkout.session.async_payment_failed` | Loga, não ativa |
| `charge.refunded` (full) | Payment vira `refunded`, user vira `expired`, `expires_at = NOW` (acesso bloqueado imediatamente) |
| `charge.refunded` (parcial) | Payment vira `partial_refund` com `refunded_cents` setado, user **continua active** (cliente pagou parte) |
| `charge.refund.updated` | Loga (SEPA refunds podem falhar depois) |
| Outros | Ignorados silenciosamente |

**Idempotência:** UNIQUE em `payments.stripe_session_id` — se Stripe reenviar o mesmo evento, processa só uma vez. Para refunds, lookup é por `stripe_payment_intent` na tabela `payments`.

**Eventos que você precisa habilitar no Stripe Dashboard → Webhooks:**

```
✓ checkout.session.completed
✓ checkout.session.async_payment_succeeded
✓ checkout.session.async_payment_failed
✓ charge.refunded
✓ charge.refund.updated
```

**Erros:** `400 invalid_signature` (não veio do Stripe ou secret errado), `500 handler_error` (faz Stripe retentar).

---

## Conta do usuário

### `GET /api/me/payments`

Lista os próprios pagamentos do usuário logado.

**200 OK:**
```json
[
  {
    "id": 1,
    "stripe_session_id": "cs_test_...",
    "amount_cents": 1000,
    "currency": "EUR",
    "status": "paid",
    "paid_at": "2026-05-25T18:46:58Z",
    "created_at": "2026-05-25T18:46:58Z"
  }
]
```

Até 50 entries por chamada, ordenadas por id DESC.

---

## Health & misc

### `GET /api/health`

Não requer autenticação. Usado por Docker healthcheck e monitoramento.

**200 OK:**
```json
{
  "ok": true,
  "now": "2026-05-26T00:08:40Z",
  "trial_questions": 15
}
```

---

## Versionamento

API atual: **v0.2.0**.
Não há prefixo `/v1/` — backend tem 1 versão por vez. Quando precisar quebrar contrato, vou adicionar `/v2/` em paralelo.

## CORS

**Desabilitado** — frontend é same-origin via proxy do webserver. Não há domínios cruzados consumindo a API.

## Rate limits (defesa em profundidade, complementa o CDN/WAF)

| Endpoint | Limite | Janela |
|---|---|---|
| `/api/auth/register` | 5 | 10 min |
| `/api/auth/login` | 10 | 5 min |
| `/api/auth/change-password` | 5 | 10 min |
| `/api/trial/check` | 120 | 5 min |
| `/api/coupons/validate` | 20 | 5 min |
| `/api/checkout/create-session` | 10 | 10 min |

Todos os limites são in-memory por processo (suficiente para um container). Para escala horizontal, migrar para Redis.

## Schemas Pydantic completos

Ver `app/main.py` — modelos `RegisterIn`, `LoginIn`, `UserOut`, `ChangePasswordIn`, `PaymentOut`, `TrialCheckIn`, `TrialCheckOut`, `CouponIn`, `CouponOut`, `CheckoutOut`.
