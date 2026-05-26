# Einbürgerungstest — Documentação

App de prática para o teste de cidadania alemã (catálogo oficial da **Baviera**, 310 questões).
SaaS com conta de usuário, paywall após 15 perguntas grátis, pagamento via Stripe (€10 / 1 ano),
e UI em **5 idiomas** (Português, Inglês, Turco, Árabe, Persa).

## Visão rápida

- **Stack:** HTML/CSS/JS puro no frontend, Python+FastAPI+SQLite no backend, Nginx/Apache na frente.
- **Servidor dev (atual):** Apache em `10.0.10.200` → `https://einburgerungstest.cloudintrip.com`
- **Servidor produção (alvo):** Nginx em `178.105.184.172` → `https://einburgerungstest.gatherpause.com` (DNS via Squarespace)
- **Pagamento:** Stripe (PayPal habilitado dentro do mesmo checkout), conta Gatherpause.
- **CDN/WAF:** BYOR-SEC na frente do domínio público.

## Índice da documentação

| Documento | O que cobre |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Componentes (frontend, backend, banco, integrações), diagrama de fluxo |
| [API.md](API.md) | Todos os endpoints REST (auth, trial, cupons, checkout, webhook) |
| [SECURITY.md](SECURITY.md) | Camadas de segurança: bcrypt, rate-limit, headers, anti-abuso por IP, cookies |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Passo-a-passo para deploy em servidor novo, troca de chaves test→live |
| [OPERATIONS.md](OPERATIONS.md) | Runbook: logs, backup SQLite, restart, troubleshooting comum |

## Estrutura de pastas no servidor

```
/var/www/html/einburgerungstest/    # frontend estático servido pelo webserver
  ├── index.html
  ├── app.js, auth.js, tour.js, i18n.js, styles.css
  ├── i18n/<lang>.json (6 arquivos: de, en, pt, tr, ar, fa)
  ├── data/
  │   ├── questions.json     (310 questões oficiais)
  │   ├── translations.json  (5 traduções por questão)
  │   └── glossary.json      (vocabulário)
  └── images/                (bandeiras, imagens das questões)

/home/cloudin/backend-einb/         # backend FastAPI em Docker
  ├── docker-compose.yml
  ├── Dockerfile
  ├── requirements.txt
  ├── .env                    (chmod 600, fora do git — Stripe + salt)
  ├── app/
  │   ├── main.py
  │   ├── auth.py
  │   ├── db.py
  │   ├── security.py
  │   ├── stripe_handler.py
  │   └── seed_coupons.py
  └── data/
      └── einb.sqlite         (volume persistente)
```

## Fluxos principais

### 1. Visitante anônimo
1. Abre o site → Welcome screen com 5 bandeiras de idioma
2. Escolhe idioma → tour automático (1ª vez)
3. Estuda até 15 perguntas grátis (validado pelo backend, ver SECURITY)
4. Na 16ª pergunta → modal "Criar conta — €10/ano"

### 2. Cadastro → pagamento → ativação
1. `POST /api/auth/register` → conta criada com status `pending`
2. Usuário clica "Pagar agora" → `POST /api/checkout/create-session`
3. Redirect para Stripe Checkout (cartão / PayPal / SEPA)
4. Pagamento aprovado → Stripe dispara webhook `POST /api/webhooks/stripe`
5. Backend valida assinatura, marca conta `active`, seta `expires_at = +1 ano`
6. Frontend faz polling em `/api/auth/me` e detecta ativação

### 3. Expiração
- Após 1 ano, conta volta para `expired` (cron diário)
- Usuário precisa repagar para renovar
