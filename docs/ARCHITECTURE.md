# Arquitetura

## Diagrama

```
                   ┌────────────────────────┐
                   │  Browser do visitante  │
                   └───────────┬────────────┘
                               │ HTTPS
                   ┌───────────▼────────────┐
                   │   CDN / WAF (BYOR)     │  ← rate-limit, headers, cache estáticos
                   └───────────┬────────────┘
                               │
        ┌──────────────────────┴──────────────────────┐
        │                                             │
┌───────▼─────────────┐                  ┌────────────▼───────────┐
│  Apache/Nginx       │                  │    api.stripe.com      │
│  10.0.10.200 (dev)  │                  │    Webhooks            │
│  178.105.184.172    │                  └────────────┬───────────┘
│  (prod)             │                               │
└───────┬──────┬──────┘                               │
        │      │ /api/*                               │
        │      │ proxy                                │
        │      │                                      │
        │  ┌───▼─────────────────────────────────────▼┐
        │  │  FastAPI (uvicorn) em Docker            │
        │  │  127.0.0.1:8001                         │
        │  │                                          │
        │  │  Endpoints:                              │
        │  │   /api/auth/*    (login/register/me)     │
        │  │   /api/trial/*   (anti-abuse gate)       │
        │  │   /api/coupons/* (validação cupom)       │
        │  │   /api/checkout/* (Stripe session)       │
        │  │   /api/webhooks/stripe (callback)        │
        │  │   /api/me/*      (payments do user)      │
        │  │   /api/health                            │
        │  └────────────────┬─────────────────────────┘
        │ /                 │
        │ (estáticos)       │
        │                   │
┌───────▼──────────┐    ┌───▼─────────────┐
│  HTML/JS/CSS/    │    │  SQLite         │
│  JSON i18n+      │    │  /srv/data/     │
│  questions       │    │  einb.sqlite    │
│  (filesystem)    │    │  (volume)       │
└──────────────────┘    └─────────────────┘
```

## Frontend

**Arquivos estáticos** servidos diretamente pelo webserver:

| Arquivo | Função |
|---|---|
| `index.html` | Estrutura, slots para conteúdo dinâmico via `data-i18n` |
| `i18n.js` | Carrega `/i18n/<lang>.json`, expõe `EinbI18n.t(key)`, controla `<html dir="rtl">` |
| `auth.js` | Sessão, modais (login/registro/conta/paywall), trial counter, cupom |
| `tour.js` | Tour onboarding (11 passos), auto-start na 1ª visita |
| `app.js` | Quiz: shuffle, render, navegação, favoritos, glossário, modos Lern/Prüfungs |
| `styles.css` | CSS único, responsivo (5 breakpoints), regras RTL minimais |
| `i18n/<lang>.json` | UI strings (~130 chaves por idioma) — DE como fallback |
| `data/questions.json` | 310 questões do catálogo Bayern |
| `data/translations.json` | Tradução de cada questão em 5 idiomas |
| `data/glossary.json` | Glossário de palavras alemãs comuns |

**Estado client-side (localStorage):**

| Chave | O que guarda |
|---|---|
| `einbuergerung_lang_v1` | idioma escolhido (pt/en/tr/ar/fa) |
| `einbuergerung_favorites_v1` | array de IDs das questões favoritas |
| `einbuergerung_glossary_v1` | palavras clicadas pelo usuário |
| `einbuergerung_stats_v1` | acertos/erros por questão |
| `einb_trial_seen_v1` | array de IDs das perguntas vistas (cache rápido, backend é fonte de verdade) |
| `einb_tour_done_v1` | flag de tour visto |

**Cookies (HttpOnly, Secure, SameSite=Lax):**

| Cookie | TTL | Função |
|---|---|---|
| `einb_session` | 30 dias | sessão de usuário logado |
| `einb_anon` | 1 ano | token anônimo para anti-abuso |

## Backend

**Stack:** Python 3.12 + FastAPI 0.115 + Uvicorn + SQLite + bcrypt + stripe-python.

**Container Docker:**
- Image base: `python:3.12-slim`
- Porta exposta: `127.0.0.1:8001` (só local, atrás do proxy webserver)
- Volume: `./data:/srv/data` (persiste SQLite)
- Healthcheck: `curl /api/health` a cada 30s
- Restart: `unless-stopped`

**Módulos:**

| Arquivo | Função |
|---|---|
| `main.py` | App FastAPI, schemas Pydantic, todos os endpoints |
| `db.py` | Conexão SQLite, schema DDL, migrações idempotentes |
| `auth.py` | bcrypt, criação/validação de sessões |
| `security.py` | Rate-limit in-memory, hash de IP/UA, headers middleware, password policy |
| `stripe_handler.py` | Checkout Session, webhook verification, ativação de conta |
| `seed_coupons.py` | Script CLI para criar cupons iniciais |

## Banco de dados (SQLite)

```sql
users             — contas, status, sex, expiração, role
sessions          — tokens de sessão (cookie einb_session)
coupons           — códigos promocionais (admin via CLI)
payments          — histórico de pagamentos Stripe
progress          — acertos/erros por user+questão (server-side, futuro)
anon_trial_views  — anti-abuso: anon_token + ip_hash + question_id
```

Ver `app/db.py` para o DDL completo.

## Integrações externas

| Serviço | Para que |
|---|---|
| **Stripe** | Pagamento (€10/ano), PayPal incluído no Checkout |
| **BYOR-SEC** | CDN + WAF + rate-limit edge |
| **Squarespace DNS** | A record do subdomínio (gerenciado pelo cliente) |
| **Let's Encrypt** | HTTPS gratuito (certbot no servidor) |
