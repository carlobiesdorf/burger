# BYOR-SEC CDN/WAF — Configurações pendentes

Lista completa de configurações a aplicar no painel **BYOR-SEC** para o site
`einburgerungstest.gatherpause.com`. Aplicar em ordem (do crítico para o
"nice-to-have"). Conta empresarial com acesso total.

> Origin: `178.105.184.172`, porta `80` (HTTP). Nginx + Docker. CDN fala HTTP
> com a origem (HTTPS só na borda).

---

## 🔴 0. Pré-requisito CRÍTICO — Skip-All para webhook e healthcheck

Antes de qualquer regra, garantir que estes dois paths **nunca sejam tocados**
por cache nem WAF nem rate limit:

| Path | Razão |
|------|-------|
| `/api/stripe/webhook` | Stripe **precisa** entregar. Qualquer challenge/block quebra pagamento. |
| `/api/health` | Healthcheck externo (UptimeRobot) — deve responder sempre. |

**Ação**: criar regra *Skip All Security Features* + *Skip Cache* para esses
2 paths, posicionada acima de qualquer outra regra.

**Whitelist** dos IPs do Stripe para `/api/stripe/webhook`:
- Lista oficial: <https://stripe.com/files/ips/ips_webhooks.txt>

---

## ⚡ 1. Cache — TTL por tipo de conteúdo

| Path                              | Edge TTL | Browser TTL | Notas |
|-----------------------------------|----------|-------------|-------|
| `/api/*`                          | **0 / Bypass** | **0**       | Já desligado; formalizar regra |
| `*.html`, `/`                     | 60s      | 60s         | revalidate com ETag |
| `/data/states.json`               | 1 day    | 1 day       | muda raramente |
| `/data/questions.json`            | 1 hour   | 1 hour      | versionado via `?v=` |
| `/data/translations.json`         | 1 hour   | 1 hour      | versionado |
| `/data/glossary.json`             | 1 hour   | 1 hour      | versionado |
| `/i18n/*.json`                    | 5 min    | 5 min       | mais volátil |
| `/images/*`                       | 1 year   | 1 year      | imutável |
| `/germany.svg`                    | 1 year   | 1 year      | imutável |
| `*.js`, `*.css`                   | 1 year   | 1 year      | cache-bust via `?v=` |

**Ativar** *Respect Origin Cache-Control* — o backend manda os headers
certos (`no-store` em `/api/*`).

---

## 🚦 2. Bypass cache quando usuário logado

Bypass cache **se houver** qualquer um destes cookies na requisição:

- `einb_session` — usuário autenticado
- `einb_anon` — token anônimo de trial

Sem isso, conteúdo personalizado de usuário A pode ser servido a usuário B.

---

## 🔥 3. Rate Limiting (per-IP, no edge)

Backend já tem rate limit interno. Estes são **outer ring** anti-DDoS:

| Path                        | Limite          | Ação      |
|-----------------------------|-----------------|-----------|
| `/api/auth/login`           | 20 req / 5 min  | challenge |
| `/api/auth/register`        | 10 req / 10 min | block     |
| `/api/auth/change-password` | 10 req / 10 min | block     |
| `/api/contact`              | 30 req / 1 hour | challenge |
| `/api/trial/check`          | 60 req / 1 hour | challenge |
| `/api/*` (genérico)         | 300 req / 1 min | block     |
| Site inteiro                | 600 req / 1 min | challenge |

---

## 🛡️ 4. WAF — OWASP CRS + Bot Mitigation

- [ ] **OWASP Core Rule Set** ativar (paranoia level 2)
- [ ] **SQL Injection** — block
- [ ] **XSS** — block
- [ ] **RCE / Command Injection** — block
- [ ] **Path Traversal** — block
- [ ] **HTTP Request Smuggling** — block
- [ ] **Bot Score**: challenge se < 30, block se < 10
  - Exceções (whitelist): Stripe webhook IPs, UptimeRobot IPs
- [ ] **Known bad IPs / Threat Intel feed** — block

> "Aggressive Bot mode" só ativar se notar abuso — pode atrapalhar usuários
> com VPN.

---

## 🌐 5. DDoS Protection

- [ ] **L3/L4** (SYN flood, UDP flood) — full mitigation
- [ ] **L7 HTTP flood** — challenge se > 100 req/s do mesmo IP
- [ ] **Slowloris** — enable
- [ ] **Connection limit per IP**: 50 concurrent

---

## 🔒 6. TLS / HTTPS

| Setting                     | Value                                          |
|-----------------------------|------------------------------------------------|
| Minimum TLS                 | **1.2** (idealmente só 1.3)                    |
| Cipher suites               | Modern (AES-GCM + ChaCha20)                    |
| HSTS                        | `max-age=31536000; includeSubDomains; preload` |
| HTTP → HTTPS                | 301 force redirect                             |
| OCSP Stapling               | enable                                         |
| Certificate Transparency    | enable                                         |
| TLS Session Resume          | enable (tickets + IDs)                         |
| 0-RTT (TLS 1.3)             | enable                                         |

Submeter `gatherpause.com` na [HSTS preload list](https://hstspreload.org/)
**depois de 7 dias** com HSTS funcionando.

---

## 📋 7. Headers de Segurança (CDN injeta)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(self "https://js.stripe.com" "https://hooks.stripe.com")
Cross-Origin-Opener-Policy: same-origin-allow-popups
X-XSS-Protection: 0
```

**NÃO adicionar** (quebra coisas):
- `Content-Security-Policy` agressiva → quebra Stripe Checkout
- `Cross-Origin-Embedder-Policy: require-corp` → quebra imagens externas

Se quiser CSP, comece com `Content-Security-Policy-Report-Only` por 1 semana.

---

## 🌍 8. Geo / IP Rules

- [ ] Whitelist Stripe webhook IPs (lista oficial)
- [ ] Whitelist UptimeRobot IPs (quando cadastrar)
- [ ] (Opcional) Block KP (Coreia do Norte) por compliance/sanctions
- [ ] (Opcional) Rate-limit mais apertado fora da Europa+Ásia+Brasil

---

## ⚙️ 9. Origin / Performance

| Setting                  | Value               |
|--------------------------|---------------------|
| Origin host              | `178.105.184.172`   |
| Origin port              | 80                  |
| Origin SSL               | **OFF**             |
| Origin keepalive         | enable              |
| Origin connection pool   | 100                 |
| Health check path        | `/api/health`       |
| Health check interval    | 30s                 |
| Health check expected    | HTTP 200            |
| Brotli compression       | enable              |
| Gzip fallback            | enable              |
| HTTP/2                   | enable              |
| HTTP/3 (QUIC)            | enable (se disp.)   |
| Image Polish (WebP/AVIF) | enable (não tocar SVG) |
| Early Hints (103)        | enable (se disp.)   |

---

## 📊 10. Logging & Alerts

- [ ] Real-time logs ativos
- [ ] Alerta: **5xx spike** > 10 erros em 5 min
- [ ] Alerta: **WAF blocks spike** > 100 blocks/min (sinal de ataque)
- [ ] Alerta: **Origin unreachable** (já tem Telegram de backup)
- [ ] Alerta: **Certificate expiry** 30 dias antes
- [ ] Retenção: **30 dias mínimo** (forense)
- [ ] (Opcional) Exportar para SIEM (Splunk/Datadog/etc.)

---

## 🌐 11. DNS-level (no registrar — Squarespace)

- [ ] **DNSSEC** enable (se Squarespace permite)
- [ ] **CAA records**:
  ```
  gatherpause.com.  CAA  0 issue "letsencrypt.org"
  gatherpause.com.  CAA  0 issuewild ";"
  gatherpause.com.  CAA  0 iodef "mailto:carlosbiesdorf@gmail.com"
  ```
- [ ] TTL dos A/CNAME: 300s (failover rápido)

---

## ✅ 12. Ordem de execução recomendada

1. Skip-All para `/api/stripe/webhook` e `/api/health`
2. Whitelist IPs Stripe
3. Cache rules por path
4. Bypass cache se cookie `einb_session` ou `einb_anon` presente
5. Rate limit rules
6. WAF OWASP (paranoia 2)
7. TLS 1.2+, HSTS, force HTTPS
8. Headers de segurança
9. Brotli + HTTP/2 + HTTP/3
10. Image optimization (exceto SVG)
11. Logging + alertas 5xx/WAF
12. DNSSEC + CAA no registrar
13. Após 7 dias OK: submeter HSTS preload

---

## 🧪 13. Como validar depois

```bash
# TLS — esperar A+
https://www.ssllabs.com/ssltest/analyze.html?d=einburgerungstest.gatherpause.com

# Headers de segurança — esperar A
https://securityheaders.com/?q=einburgerungstest.gatherpause.com

# Cache headers
curl -I https://einburgerungstest.gatherpause.com/data/states.json
curl -I https://einburgerungstest.gatherpause.com/api/health

# WAF / OWASP test (manual)
curl "https://einburgerungstest.gatherpause.com/api/health?test=' OR 1=1--"
# (deve ser bloqueado pelo WAF)
```

**Objetivos**:
- 🟢 SSL Labs **A+**
- 🟢 securityheaders.com **A**
- 🟢 Zero vulnerabilidades OWASP top 10
- 🟢 Webhook Stripe entregando 100% (verificar Stripe Dashboard)
- 🟢 Healthcheck UptimeRobot 99.9%+

---

_Última atualização: 2026-05-26_
_Autor: Carlos Biesdorf (com assistência Claude)_
