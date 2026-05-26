# Operações — runbook

Comandos essenciais para operar o site em produção. Todos rodam por SSH no servidor.

## Endpoints

| Ambiente | Endereço |
|---|---|
| Dev | `ssh -p 2222 cloudin@10.0.10.200` → `https://einburgerungstest.cloudintrip.com` |
| Prod | `ssh cloudin@178.105.184.172` → `https://einburgerungstest.gatherpause.com` |

## Estrutura no servidor

```
/var/www/html/einburgerungstest/  → frontend estático (Apache/Nginx serve)
/home/cloudin/backend-einb/       → backend FastAPI (Docker)
   ├── docker-compose.yml
   ├── Dockerfile
   ├── .env                       → secrets (chmod 600)
   ├── app/                       → código Python
   └── data/einb.sqlite           → banco persistente
```

## Comandos comuns

### Backend (Docker)

```bash
cd /home/cloudin/backend-einb

# Status
docker ps --filter name=einb-backend

# Logs (últimas 100 linhas, follow)
docker logs --tail 100 -f einb-backend

# Logs filtrados (login fails)
docker logs einb-backend 2>&1 | grep -E 'login_fail|register_success|trial_block'

# Após mudar .env (precisa recriar o container, NÃO basta restart)
docker-compose up -d --force-recreate
# Nota: `docker-compose restart` NÃO relê o .env — só reinicia o processo
# dentro do mesmo container que mantém as env vars antigas.

# Rebuild (após mudar código Python)
docker-compose up -d --build

# Force-recreate (após mudar .env E código)
docker-compose up -d --build --force-recreate

# Shell dentro do container
docker exec -it einb-backend bash

# Rodar comando ad-hoc
docker exec einb-backend python -m app.seed_coupons
```

### Banco de dados SQLite

```bash
# Abrir CLI
docker exec -it einb-backend python -c "
import sqlite3, sys
c = sqlite3.connect('/srv/data/einb.sqlite')
c.row_factory = sqlite3.Row
# exemplo:
for r in c.execute('SELECT id, email, status, expires_at FROM users ORDER BY id DESC LIMIT 10'):
    print(dict(r))
"

# Backup pontual (copia o arquivo enquanto o app está rodando — SQLite WAL é safe)
docker exec einb-backend sqlite3 /srv/data/einb.sqlite ".backup /srv/data/backup-$(date +%Y%m%d-%H%M).sqlite"
docker cp einb-backend:/srv/data/backup-$(date +%Y%m%d-%H%M).sqlite ~/

# Total de contas ativas
docker exec einb-backend python -c "
import sqlite3
c = sqlite3.connect('/srv/data/einb.sqlite')
print('active:', c.execute('SELECT COUNT(*) FROM users WHERE status=\"active\"').fetchone()[0])
print('pending:', c.execute('SELECT COUNT(*) FROM users WHERE status=\"pending\"').fetchone()[0])
print('total payments:', c.execute('SELECT COUNT(*), SUM(amount_cents) FROM payments WHERE status=\"paid\"').fetchone())
"
```

### Cupons (gerenciamento via CLI)

> **Em breve:** painel admin web em `https://einburgerungstest.gatherpause.com/` → "Mein Konto" → "Admin" → "Cupons" (acessível só para `is_admin=1`). Até lá, use os comandos abaixo via SSH.

#### Listar todos os cupons

```bash
ssh 178.105.184.172 "sg docker -c 'docker exec einb-backend python3 -c \"
import sqlite3
c = sqlite3.connect(\\\"/srv/data/einb.sqlite\\\")
c.row_factory = sqlite3.Row
print(f\\\"{\\\\\\\"code\\\\\\\":<20} {\\\\\\\"partner\\\\\\\":<15} {\\\\\\\"pct\\\\\\\":<5} {\\\\\\\"cents\\\\\\\":<8} {\\\\\\\"used\\\\\\\":<8} {\\\\\\\"max\\\\\\\":<8} {\\\\\\\"valid_until\\\\\\\":<25} {\\\\\\\"active\\\\\\\"}\\\")
for r in c.execute(\\\"SELECT code, partner, discount_pct, discount_cents, used_count, max_uses, valid_until, active FROM coupons ORDER BY created_at DESC\\\"):
    print(f\\\"{r[0]:<20} {(r[1] or \\\\\\\"-\\\\\\\"):<15} {(str(r[2]) or \\\\\\\"-\\\\\\\"):<5} {(str(r[3]) or \\\\\\\"-\\\\\\\"):<8} {r[4]:<8} {(str(r[5]) if r[5] else \\\\\\\"inf\\\\\\\"):<8} {(r[6] or \\\\\\\"-\\\\\\\"):<25} {r[7]}\\\")
\"'"
```

#### Criar cupom de parceiro (% off)

Exemplo: cupom `MUNICH20` para parceiro "Munich Club" com **20% de desconto**, válido por **180 dias**, **máximo 500 usos**.

```bash
ssh 178.105.184.172 "sg docker -c 'docker exec einb-backend python3 <<\"PYEOF\"
import sqlite3
from datetime import datetime, timedelta, timezone

# === EDITAR ESTES VALORES ===
CODE = \"MUNICH20\"
PARTNER = \"Munich Club\"
DISCOUNT_PCT = 20             # % off (1-100). Para valor em €, deixar None e usar DISCOUNT_CENTS abaixo
DISCOUNT_CENTS = None         # ou ex.: 300 para 3 €
VALID_DAYS = 180              # dias até expirar. None = nunca expira
MAX_USES = 500                # None = ilimitado
# ============================

valid_until = (datetime.now(timezone.utc) + timedelta(days=VALID_DAYS)).isoformat() if VALID_DAYS else None
c = sqlite3.connect(\"/srv/data/einb.sqlite\")
c.execute(\"\"\"INSERT OR REPLACE INTO coupons (code, partner, discount_pct, discount_cents, valid_until, max_uses, used_count, active)
             VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT used_count FROM coupons WHERE code=?), 0), 1)\"\"\",
          (CODE, PARTNER, DISCOUNT_PCT, DISCOUNT_CENTS, valid_until, MAX_USES, CODE))
c.commit()
print(f\"✓ cupom {CODE} criado/atualizado\")
PYEOF
'"
```

#### Criar cupom com valor fixo em € (em vez de %)

Trocar no script acima:
```python
DISCOUNT_PCT = None          # desliga o %
DISCOUNT_CENTS = 300         # 3,00 € de desconto
```

#### Desativar cupom

```bash
ssh 178.105.184.172 "sg docker -c 'docker exec einb-backend python3 -c \"
import sqlite3
sqlite3.connect(\\\"/srv/data/einb.sqlite\\\").execute(\\\"UPDATE coupons SET active=0 WHERE code=?\\\", (\\\"MUNICH20\\\",))
print(\\\"desativado\\\")
\"'"
```

#### Estatística de uso de cupons

Quantos usuários se cadastraram com cada cupom (e quantos efetivamente pagaram):

```bash
ssh 178.105.184.172 "sg docker -c 'docker exec einb-backend python3 -c \"
import sqlite3
c = sqlite3.connect(\\\"/srv/data/einb.sqlite\\\")
c.row_factory = sqlite3.Row
print(f\\\"{\\\\\\\"cupom\\\\\\\":<20} {\\\\\\\"cadastros\\\\\\\":<12} {\\\\\\\"pagaram\\\\\\\":<10} {\\\\\\\"conversao\\\\\\\"}\\\")
for r in c.execute(\\\"\\\"\\\"
    SELECT coupon_code AS code,
           COUNT(*) AS cads,
           SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS paid
    FROM users WHERE coupon_code IS NOT NULL
    GROUP BY coupon_code ORDER BY cads DESC\\\"\\\"\\\"):
    rate = round((r[\\\"paid\\\"] or 0)/max(r[\\\"cads\\\"],1)*100)
    print(f\\\"{r[\\\\\\\"code\\\\\\\"]:<20} {r[\\\\\\\"cads\\\\\\\"]:<12} {(r[\\\\\\\"paid\\\\\\\"] or 0):<10} {rate}%\\\")
\"'"
```

#### Como funciona o desconto no Stripe

Quando o usuário se cadastra com cupom (`coupon_code` salvo em `users`), no `POST /api/checkout/create-session` o backend:

1. Procura o cupom no Stripe (`stripe.PromotionCode.list(code=...)`).
2. Se **não existe** no Stripe, cria automaticamente: `stripe.Coupon.create(percent_off=10)` + `stripe.PromotionCode.create(code='MUNICH20', coupon=...)`.
3. Aplica o `promotion_code` à Stripe Checkout Session.
4. Stripe mostra o desconto na página de pagamento e cobra valor correto.

**Você não precisa criar o cupom dentro do Stripe** — o backend faz isso on-the-fly. Você só precisa cadastrar no seu DB local com os passos acima.

#### Recomendação operacional

- **Cupons de parceiros internos**: nomear como `<PARTNER>-<DISC>` (ex: `MUNICH-20`, `INFLUENCER-15`).
- **Cupons de campanha**: nomear com prefixo da campanha (ex: `BLACKFRIDAY24`, `WELCOME10`).
- **Validade**: sempre defina `VALID_DAYS` para evitar cupons eternos esquecidos.
- **Limite de uso**: defina `MAX_USES` para campanhas — protege caso vaze online (parceiro compartilhando demais).
- **Desativação**: nunca delete um cupom usado (`DELETE FROM coupons`) pois quebra rastreabilidade dos `users.coupon_code`. Use `UPDATE coupons SET active=0`.

### Frontend (estático)

```bash
# Forçar refresh do cache CDN: depende do painel BYOR-SEC, ou apenas espera TTL.
# Para atualizar local:
sudo cp /tmp/styles.css /var/www/html/einburgerungstest/styles.css
sudo chown www-data:www-data /var/www/html/einburgerungstest/styles.css

# Ver versão atual (mtime do app.js)
ls -la /var/www/html/einburgerungstest/app.js
```

## Webserver

### Apache (dev — 10.0.10.200)

```bash
sudo apache2ctl configtest          # valida config antes de aplicar
sudo systemctl reload apache2       # graceful (não derruba conexões)
sudo tail -f /var/log/apache2/einburgerungstest_access.log
sudo tail -f /var/log/apache2/einburgerungstest_error.log
```

Config: `/etc/apache2/sites-available/einburgerungstest-le-ssl.conf`

### Nginx (prod — 178.105.184.172)

```bash
sudo nginx -t                       # valida config
sudo systemctl reload nginx
sudo tail -f /var/log/nginx/einburgerungstest_access.log
sudo tail -f /var/log/nginx/einburgerungstest_error.log
```

Config: `/etc/nginx/sites-available/einburgerungstest.conf`

## Certificados HTTPS

```bash
# Listar certs
sudo certbot certificates

# Renovação manual (geralmente é automática via cron)
sudo certbot renew --dry-run
sudo certbot renew

# Após renovar com nginx
sudo systemctl reload nginx
```

## Backups

### SQLite — backup diário automático (instalado)

**Script:** `/home/cloudin/scripts/backup-to-nextcloud.sh`
**Credenciais:** `/home/cloudin/scripts/einb-backup.env` (chmod 600 — não vai pro git)
**Local:** `/home/cloudin/backups/einb-YYYYMMDD-HHMM.sqlite.gz` (retenção 30 dias)
**Remoto:** Nextcloud `https://cloud.cloudintrip.com` → pasta `einb-backups/` (via WebDAV)
**Cron:** diário às 03:30 (crontab do user `cloudin`).
**Alertas Telegram:**
- Toda 2ª-feira: confirmação do backup semanal
- Qualquer falha de upload: alerta imediato

**Comandos úteis:**

```bash
# Rodar backup manualmente (qualquer horário)
/home/cloudin/scripts/backup-to-nextcloud.sh

# Ver últimos backups locais
ls -la /home/cloudin/backups/

# Ver último log
tail -20 /home/cloudin/logs/backup.log

# Listar backups no Nextcloud
curl -s -u carlosbiesdorf:$NC_APP_PW -X PROPFIND \
    'https://cloud.cloudintrip.com/remote.php/dav/files/carlosbiesdorf/einb-backups/' \
    | grep -oE 'einb-[0-9-]+\.sqlite\.gz'

# Baixar um backup específico do Nextcloud
curl -u carlosbiesdorf:$NC_APP_PW \
    'https://cloud.cloudintrip.com/remote.php/dav/files/carlosbiesdorf/einb-backups/einb-20260526-1118.sqlite.gz' \
    -o restore.sqlite.gz

# Restaurar
gunzip restore.sqlite.gz
docker-compose down
cp restore.sqlite /home/cloudin/backend-einb/data/einb.sqlite
docker-compose up -d
```

**Trocar a app password do Nextcloud:**
1. Cria nova app password no Nextcloud (Configurações pessoais → Segurança → Dispositivos e sessões)
2. Edita `/home/cloudin/scripts/einb-backup.env`, troca `NC_APP_PW=...`
3. Revoga a antiga no Nextcloud
4. Testa manualmente: `/home/cloudin/scripts/backup-to-nextcloud.sh`

### Frontend + backend código

Versionado em git. Para snapshot pontual:

```bash
tar czf einb-snapshot-$(date +%Y%m%d).tgz \
    /var/www/html/einburgerungstest \
    /home/cloudin/backend-einb \
    --exclude='**/data/*' \
    --exclude='**/__pycache__'
```

## Tarefas periódicas (cron)

```bash
# Crontab do usuário cloudin (`crontab -e`)
# Expirar contas pagas há mais de 1 ano (diário 03:00)
0 3 * * * docker exec einb-backend python -c "import sqlite3; sqlite3.connect('/srv/data/einb.sqlite').execute(\"UPDATE users SET status='expired' WHERE status='active' AND expires_at < CURRENT_TIMESTAMP\")"

# Purgar trials anônimos antigos (semanal — economiza espaço, não afeta nada)
0 4 * * 0 docker exec einb-backend python -c "import sqlite3; sqlite3.connect('/srv/data/einb.sqlite').execute(\"DELETE FROM anon_trial_views WHERE seen_at < datetime('now', '-30 days')\")"

# Purgar sessões expiradas (diário)
0 4 * * * docker exec einb-backend python -c "import sqlite3; sqlite3.connect('/srv/data/einb.sqlite').execute(\"DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP\")"
```

## Troubleshooting

### Backend não responde

```bash
docker ps --filter name=einb-backend            # rodando?
docker logs --tail 30 einb-backend              # erros?
curl http://127.0.0.1:8001/api/health           # responde local?
curl https://einburgerungstest.cloudintrip.com/api/health   # responde via proxy?
```

Se rodando mas não responde: pode estar travado na inicialização (DB corrupto, .env mal parseado). Logs do uvicorn na startup mostram.

Se não está rodando: `cd /home/cloudin/backend-einb && docker-compose up -d` e ver logs.

### Stripe webhook não chega

- Confirma URL na dashboard Stripe: `Developers → Webhooks → endpoint`.
- Testa entrega manual: na dashboard tem botão "Send test webhook".
- Logs no backend: `docker logs einb-backend 2>&1 | grep webhook`.
- Backend deve responder 200; se retorna 400 com `invalid_signature`, o `STRIPE_WEBHOOK_SECRET` no `.env` não bate.

### Usuário não consegue logar

1. Conta existe? `SELECT id, status FROM users WHERE email = '...'`
2. Status pending → ele precisa pagar (paywall pós-cadastro).
3. Status expired → expirou após 1 ano, precisa renovar.
4. Rate-limit (10 tentativas / 5 min)? Logs: `grep login_fail`.

### Conta paga mas não ativada

1. Webhook chegou? `docker logs einb-backend 2>&1 | grep -i webhook`
2. Pagamento na dashboard Stripe?
3. Row em `payments`? `SELECT * FROM payments WHERE user_id = ?`
4. Reprocessar manualmente: na dashboard Stripe, no event, clica "Resend". Backend é idempotente.
5. Última tentativa: ativar à mão.

```bash
docker exec einb-backend python -c "
import sqlite3
from datetime import datetime, timedelta, timezone
c = sqlite3.connect('/srv/data/einb.sqlite')
now = datetime.now(timezone.utc).isoformat()
exp = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()
c.execute('UPDATE users SET status=?, activated_at=?, expires_at=? WHERE id = ?',
          ('active', now, exp, USER_ID))
c.commit()
print('ativado.')
"
```

### Reset trial de um usuário específico (suporte ao cliente)

```bash
# Por token anônimo
docker exec einb-backend sqlite3 /srv/data/einb.sqlite "DELETE FROM anon_trial_views WHERE anon_token = 'TOKEN'"

# Por IP (todos os tokens que vieram daquele IP — útil em casos de NAT compartilhado)
# Note: precisa do hash, não do IP raw (não temos o IP raw)
```

## Monitoramento sugerido

- Uptime: monitorar `GET /api/health` a cada 1min de fora do servidor.
- Logs estruturados: backend usa `logging` com formato `%(asctime)s %(levelname)s %(name)s %(message)s`. Plugar em qualquer log aggregator (Loki, ELK, Datadog).
- Métricas de negócio: query SQLite no cron 10min publica em qualquer dashboard.
