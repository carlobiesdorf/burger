# CDN / WAF — Referência completa (estado da arte 2025-2026)

Documento educativo. Lista exaustiva de capacidades modernas em CDN, cache e
WAF — usado ou não no projeto, é útil saber o que existe para tomar decisões
informadas no futuro.

> **Fonte**: síntese de docs públicos de Cloudflare, Fastly, AWS CloudFront +
> WAF v2 + Shield, Akamai, Bunny.net, Google Cloud CDN + Cloud Armor, Azure
> Front Door + WAF, OWASP Core Rule Set v4, PCI-DSS 4.0, MDN Web Docs,
> RFC 9111 (HTTP Caching) e RFC 9110 (HTTP Semantics).

---

## Parte 1 — CDN / Cache

### 1.1 Modos de cache (cache modes)

| Modo | Descrição | Quando usar |
|------|-----------|-------------|
| **Standard** | CDN respeita `Cache-Control` do origin | Default razoável |
| **Cache Everything** | Cacheia tudo independente do header origin | Sites 100% estáticos |
| **Bypass** | Nunca cacheia, sempre vai ao origin | `/api/*`, webhooks |
| **No-cache (revalidate)** | Cacheia mas valida com origin via `If-None-Match`/`If-Modified-Since` | HTML que pode mudar |
| **Stale-while-revalidate** | Serve versão velha enquanto busca nova em background | UX rápida + dados frescos |
| **Stale-if-error** | Serve cache velho se origin cair | Resiliência |
| **Tiered Cache / Hierarchical** | Edge → Region → Origin shield | Reduz tráfego no origin |
| **Origin Shield** | Camada intermediária centralizada antes do origin | Sites com poucos GETs únicos |

### 1.2 Chave de cache (cache key)

O que entra na chave define se 2 requests são "iguais" para o cache.
**Componentes padrão**:

- Host
- Path
- Query string (full OR específicas OR ignore)

**Componentes opcionais avançados**:

- Header `Accept-Encoding` (separa Gzip/Brotli/identity)
- Header `Accept-Language` (separa por idioma)
- Header `User-Agent` family (mobile vs desktop)
- Cookies específicos (separa logged-in / anonymous)
- `Origin`/`Referer` (para CORS)
- Geographic (país de origem)
- Custom request headers
- TLS version / cipher
- HTTP method (raramente — normalmente só GET cacheia)

**Boas práticas**:
- Incluir só o necessário (cada componente ↓ hit rate)
- Normalizar query string (ordenar parâmetros) antes da chave
- Strip parâmetros de tracking (`utm_*`, `fbclid`, `gclid`)

### 1.3 TTL (Time To Live)

Tipos de TTL que CDNs modernos expõem:

- **Edge TTL** (s-maxage) — quanto o CDN guarda
- **Browser TTL** (max-age) — quanto o navegador guarda
- **Stale TTL** — janela em que cache velho pode ser servido
- **Negative cache TTL** — quanto cacheia respostas 404/5xx
- **Min/Max TTL clamp** — sobrescreve range do origin

### 1.4 Invalidação / Purge

| Técnica | Granularidade | Latência |
|---------|---------------|----------|
| **Purge by URL** | 1 arquivo | seg–min |
| **Purge by prefix** | `/data/*` | seg–min |
| **Purge by tag (Cache-Tag header)** | múltiplos arquivos com mesma tag | seg |
| **Purge by surrogate key** | Fastly: tagging avançado | ms–seg |
| **Purge everything** | todo o domínio | min |
| **Versioned URL** (`/app.js?v=20260526`) | controle via deploy, sem purge | instantâneo |

**Best practice moderna**: usar **content-hash** (`/app.abc123.js`) — cada
deploy gera URL nova, browser/CDN cacheiam 1 ano (`immutable`).

### 1.5 Compressão

- **Gzip** — universal, ratio bom
- **Brotli** — 15-25% melhor que Gzip, suporte 95%+ browsers
- **Zstandard (zstd)** — RFC 8878, ainda emergindo, suporte limitado
- **Static pre-compression** — Brotli max compression no build, CDN serve direto

### 1.6 Protocolos

| Protocolo | Status | Benefício |
|-----------|--------|-----------|
| HTTP/1.1 | universal | baseline |
| HTTP/2 | universal | multiplexing, header compression (HPACK) |
| HTTP/3 (QUIC) | crescendo | UDP-based, 0-RTT, melhor em rede ruim |
| TLS 1.3 | padrão | handshake 1-RTT, 0-RTT resume |
| **Early Hints (103)** | crescendo | servidor manda `Link: <preload>` antes da resposta final |
| **WebSockets** | universal | conexão persistente |
| **gRPC** | em CDN modernas | RPC binário sobre HTTP/2 |

### 1.7 Otimizações na borda (edge optimization)

- **Image optimization**: auto-conversão para WebP/AVIF, resize on-the-fly,
  quality ajustável por `Accept` header
- **Polish / Mirage** (Cloudflare), **Image Optimization** (Fastly): lazy load
- **HTML minification**
- **CSS/JS minification** (cuidado: pode quebrar source maps)
- **Mobile redirect** (raramente útil hoje)
- **Auto-inline critical CSS** (raríssimo)
- **Server Push HTTP/2** (deprecated em Chrome — usar Early Hints)
- **Rocket Loader / async script execution** (Cloudflare)

### 1.8 Cache rules avançadas (Cloudflare Rules / Fastly VCL / etc.)

Lista exaustiva do que dá pra fazer em **regras condicionais**:

**Condições disponíveis para match**:
- URL path (regex, glob, exact)
- Query string presence/value
- Method (GET, POST, etc.)
- HTTP version
- TLS version / cipher
- Host header
- Headers presence/value (qualquer header)
- Cookies (presence/value)
- IP address / subnet / country / ASN
- User-Agent family
- Bot score
- Threat score
- WAF score
- Day of week / hour of day
- Request body size
- Cache status (HIT/MISS/EXPIRED/REVALIDATED)
- Origin response code/headers/body

**Ações disponíveis**:
- Set/override cache TTL
- Bypass cache
- Add/remove/modify headers (request + response)
- Rewrite URL/path
- Redirect (301/302)
- Block (403)
- Challenge (CAPTCHA, JS challenge, Managed challenge)
- Allow (whitelist override)
- Rate limit
- Throttle (slow down progressively)
- Mirror to another origin
- A/B test (random split)
- Transform response body (Workers/VCL)
- Inject HTML (analytics tags)
- Set cookie
- Run serverless function (Cloudflare Workers, Fastly Compute, Lambda@Edge)

### 1.9 Cache headers do origin (que o CDN respeita)

```http
Cache-Control: public, max-age=31536000, immutable
Cache-Control: private, no-store
Cache-Control: s-maxage=86400, max-age=60          # CDN 1 dia, browser 1 min
Cache-Control: stale-while-revalidate=3600
Cache-Control: stale-if-error=86400
Surrogate-Control: max-age=86400, stale-while-revalidate=3600   # CDN-only
ETag: "abc123"
Last-Modified: Tue, 26 May 2026 15:00:00 GMT
Vary: Accept-Encoding, Accept-Language          # cria variantes no cache
Cache-Tag: products, homepage, pt-BR             # para purge por tag
Surrogate-Key: products homepage                # Fastly equivalent
```

### 1.10 Edge Computing (serverless na borda)

Tendência grande dos últimos anos. Plataformas:

| Plataforma | Linguagem | Runtime |
|------------|-----------|---------|
| Cloudflare Workers | JavaScript/WASM | V8 isolates |
| Fastly Compute | Rust/Go/JS/WASM | WASM runtime |
| AWS Lambda@Edge | Node/Python | Lambda |
| AWS CloudFront Functions | JS (subset) | rápido, < 1ms |
| Vercel Edge Functions | JS | V8 |
| Deno Deploy | TypeScript | Deno |
| Akamai EdgeWorkers | JS | V8 |

**Casos de uso**:
- A/B testing dinâmico
- Personalização (geolocation, idioma)
- Token validation antes do origin
- Image manipulation
- Bot detection custom
- Edge databases (Cloudflare D1, Durable Objects)

---

## Parte 2 — WAF (Web Application Firewall)

### 2.1 Tipos de WAF

| Tipo | Onde roda | Exemplos |
|------|-----------|----------|
| **Edge / CDN-based** | borda da CDN | Cloudflare, Fastly, Akamai |
| **Cloud-native** | provedor cloud | AWS WAF, Azure WAF, GCP Cloud Armor |
| **Self-hosted reverse proxy** | seu servidor | ModSecurity + OWASP CRS, NAXSI |
| **Host-based** | dentro do app | mod_security em Apache/Nginx |
| **Library WAF / RASP** | dentro do código | Snyk Sentry, Imperva RASP |

### 2.2 OWASP Core Rule Set (CRS) — padrão da indústria

CRS v4.x (atual em 2026) inclui detecção para:

- **SQL Injection** (SQLi)
- **Cross-Site Scripting** (XSS)
- **Remote Code Execution** (RCE)
- **Path Traversal / LFI / RFI**
- **HTTP Request Smuggling**
- **HTTP Response Splitting**
- **Session Fixation**
- **PHP / Java / NodeJS specific injections**
- **Command Injection** (OS commanding)
- **Data Leakage** (regex pra detectar SSN, credit card, etc.)
- **Protocol violations** (HTTP RFC compliance)
- **Anti-automation** (bots simples)

**Paranoia Levels** (1-4): cada nível adiciona regras mais estritas. Nível 2
é o "sweet spot" para sites SaaS. Nível 4 = false positives ↑↑.

### 2.3 Bot Management avançado

| Técnica | O que faz |
|---------|-----------|
| **JS challenge** | Browser precisa executar JS para passar |
| **Managed challenge** | Cloudflare escolhe entre CAPTCHA / JS / interactive |
| **CAPTCHA** | hCaptcha, reCAPTCHA, Turnstile |
| **Device fingerprinting** | TLS JA3/JA4, browser canvas, fonts |
| **Behavioral analysis** | mouse moves, typing patterns |
| **IP reputation** | listas de IPs maliciosos conhecidos |
| **ASN reputation** | bloqueia ranges de ASNs hostis |
| **Rate-based** | challenge se > X req/min |
| **HTTP header anomalies** | bot que não manda Accept-Language, etc. |
| **TLS fingerprinting (JA3/JA4)** | identifica bot pelo handshake |
| **Bot Management ML** | Cloudflare/Akamai/PerimeterX usam ML proprietário |

### 2.4 Rate Limiting — padrão da indústria

**Sim, rate limiting por path é absolutamente standard**. Todas as CDNs
empresariais suportam. Métricas comuns:

| Estratégia | Quando usar |
|------------|-------------|
| **Per-IP fixed window** | mais simples (`100 req/min`) |
| **Per-IP sliding window** | mais preciso, sem "burst" no início do bucket |
| **Per-cookie / per-session** | quando IP é compartilhado (NAT, escola, hotel) |
| **Per-API-key** | APIs com keys |
| **Per-path** | `/api/login` mais apertado que `/static/*` |
| **Per-method** | POST mais apertado que GET |
| **Per-country** | TR pode ter limite diferente de DE |
| **Per-ASN** | bloqueia abuso de cloud provider específico |
| **Token bucket** | permite bursts curtos |
| **Leaky bucket** | suaviza tráfego |
| **Concurrent requests limit** | max 10 requests simultâneos por IP |

**Ações ao exceder**: block / challenge / log only / throttle (delay).

### 2.5 DDoS Protection (multi-camada)

| Camada | O que protege | Exemplos de ataque |
|--------|---------------|-------------------|
| **L3 (network)** | SYN flood, UDP flood, amplification (DNS/NTP/Memcached) | Mirai botnet |
| **L4 (transport)** | TCP flag attacks, slow connections | Slowloris, RUDY |
| **L7 (application)** | HTTP floods, slow POST, expensive endpoints | Layer-7 floods |

CDNs grandes (Cloudflare, Akamai, AWS Shield Advanced) absorvem Tbps em L3/L4
automaticamente. L7 precisa de WAF + rate limiting + bot management.

### 2.6 Security Headers (CDN injeta ou origin manda)

| Header | Para que serve |
|--------|----------------|
| `Strict-Transport-Security` | força HTTPS |
| `Content-Security-Policy` | mitiga XSS bloqueando scripts não autorizados |
| `X-Content-Type-Options: nosniff` | impede MIME sniffing |
| `X-Frame-Options` | clickjacking |
| `Referrer-Policy` | privacidade |
| `Permissions-Policy` | bloqueia APIs do browser (camera, mic, etc.) |
| `Cross-Origin-Opener-Policy` | isola contexto de janela |
| `Cross-Origin-Embedder-Policy` | requer assets CORS-permitidos |
| `Cross-Origin-Resource-Policy` | controla quem pode embedar seus recursos |
| `Expect-CT` | (deprecated) certificate transparency |
| `Public-Key-Pins` | (deprecated, perigoso) pinning |
| `Report-To` / `NEL` | reportar violações para endpoint |

### 2.7 mTLS / Cliente certificado

CDNs modernas suportam **mutual TLS** — só conexões com certificado válido
do cliente passam. Útil para APIs B2B ou IoT.

### 2.8 Zero Trust / SASE

Tendência: substituir VPN por **acesso baseado em identidade**. Cloudflare
Access, Zscaler Private Access, Tailscale, etc. Para SaaS público (como o
Einbürgerungstest) não é relevante; pra acesso administrativo interno, sim.

### 2.9 API Security específica

- **Schema validation** (OpenAPI): rejeita request que não bate com schema
- **JSON Schema enforcement**
- **JWT validation** na borda (verify assinatura antes de chegar no origin)
- **OAuth token introspection**
- **GraphQL depth/complexity limits**
- **Sensitive data discovery** (PII detection)

### 2.10 Observability

| Capacidade | Para que |
|-----------|----------|
| **Real-time logs** | debug, forensics |
| **Sampled logs** | reduzir custo |
| **Anomaly detection** (ML) | alerta automático em spike |
| **GeoIP + ASN enrichment** | entender de onde vem tráfego |
| **WAF rule hit metrics** | tunar rules |
| **Custom dashboards** | KPIs de segurança |
| **Integração SIEM** | Splunk, Datadog, Sumo Logic, Elastic |
| **Webhook notifications** | Slack, PagerDuty, Telegram |

---

## Parte 3 — Tendências emergentes (2025-2026)

| Tendência | Status |
|-----------|--------|
| **Post-Quantum Cryptography** (ML-KEM, ML-DSA) | rollout iniciando (Chrome, Cloudflare) |
| **HTTP/3 universal** | adoção crescendo rápido |
| **TLS 1.3 only** | tornando-se padrão |
| **Encrypted Client Hello (ECH)** | esconde SNI; Cloudflare suporta |
| **Privacy Pass** | substituir CAPTCHA com tokens anônimos |
| **WASM at edge** | linguagens variadas na borda |
| **AI-powered WAF** | detectar 0-days via anomaly detection |
| **Confidential Computing** | computação em enclave (Intel SGX, AWS Nitro) |
| **Cache Strategy ML** | predict prefetch / TTL ótimo automaticamente |
| **Edge databases** | dados perto do usuário (Cloudflare D1, Turso) |
| **WebTransport** | substituto moderno de WebSockets (sobre HTTP/3) |
| **Service Worker no edge** | rodar SW no servidor |

---

## Parte 4 — Recursos para se aprofundar

- **MDN Web Docs — HTTP Caching**:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching>
- **OWASP Top 10** (atualizado a cada 3-4 anos):
  <https://owasp.org/Top10/>
- **OWASP Core Rule Set**:
  <https://coreruleset.org/>
- **Cloudflare Learning Center**:
  <https://www.cloudflare.com/learning/>
- **Fastly Developer Hub**:
  <https://developer.fastly.com/>
- **High Performance Browser Networking** (livro de Ilya Grigorik, free):
  <https://hpbn.co/>
- **RFC 9111 — HTTP Caching**:
  <https://datatracker.ietf.org/doc/html/rfc9111>
- **RFC 9110 — HTTP Semantics**:
  <https://datatracker.ietf.org/doc/html/rfc9110>
- **Web.dev** (Google) — performance + security:
  <https://web.dev/>
- **PortSwigger Web Security Academy** (gratuito, prático):
  <https://portswigger.net/web-security>
- **HackerOne disclosed reports** — aprender com bugs reais:
  <https://hackerone.com/hacktivity>

---

_Última atualização: 2026-05-26_
