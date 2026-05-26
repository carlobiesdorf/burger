# Deployment

Como subir o site num servidor novo, e como trocar chaves test ↔ live.

## Servidor produção alvo

- **Host:** `178.105.184.172` (Debian 13)
- **DNS:** `einburgerungstest.gatherpause.com` (A record no painel Squarespace → este IP)
- **HTTPS:** Let's Encrypt via certbot (depois que DNS propagar)
- **CDN/WAF:** BYOR-SEC na frente (cliente configura no painel)

## Pré-requisitos no servidor

```bash
# Verificar
nginx -v         # 1.26+ esperado
which sqlite3    # deve existir
which python3   # 3.11+ esperado
which docker     # provavelmente FALTA — instalar
```

### Instalar Docker (se faltar)

```bash
sudo apt update
sudo apt install -y docker.io docker-compose
sudo usermod -aG docker cloudin
# logout/login para o grupo aplicar
```

## Estrutura final no servidor

```
/var/www/html/einburgerungstest/    # frontend (rsync do dev)
/home/cloudin/backend-einb/         # backend (rsync do dev sem data/)
   ├── .env                          # chaves Stripe (criar à mão)
   └── data/einb.sqlite              # banco vazio na 1ª subida
/etc/nginx/sites-available/einburgerungstest.conf
/etc/nginx/sites-enabled/einburgerungstest.conf -> ...
/etc/cron.daily/einb-backup.sh
```

## Passo-a-passo (1ª subida)

### 1. Copiar frontend

```bash
# Do servidor dev para o de prod
rsync -avz -e 'ssh -p 2222' 10.0.10.200:/var/www/html/einburgerungstest/ \
    /tmp/frontend-snapshot/
rsync -avz /tmp/frontend-snapshot/ cloudin@178.105.184.172:/tmp/frontend/

# No servidor de prod:
ssh cloudin@178.105.184.172
sudo mkdir -p /var/www/html/einburgerungstest
sudo cp -r /tmp/frontend/* /var/www/html/einburgerungstest/
sudo chown -R www-data:www-data /var/www/html/einburgerungstest
sudo chmod -R 755 /var/www/html/einburgerungstest
```

### 2. Copiar backend

```bash
# Do dev (sem dados, sem secrets)
rsync -avz -e 'ssh -p 2222' \
    --exclude data --exclude .env --exclude '*.sqlite*' \
    10.0.10.200:/home/cloudin/backend-einb/ \
    cloudin@178.105.184.172:/home/cloudin/backend-einb/
```

### 3. Criar `.env` em produção

**Importante:** no início, manter chaves **test** para validar o pipeline. Trocar para live só após smoke test completo.

```bash
ssh cloudin@178.105.184.172
cd /home/cloudin/backend-einb
cat > .env <<'EOF'
# ---- Stripe (TEST por enquanto, mudar para LIVE depois) ----
STRIPE_SECRET_KEY=rk_test_...
STRIPE_PRICE_ID=price_...                   # test price
STRIPE_WEBHOOK_SECRET=whsec_...

# ---- Anti-abuse ----
ANON_HASH_SALT=GERAR_ALEATÓRIO              # ver abaixo
IP_DAILY_LIMIT=25
EOF
chmod 600 .env

# Gerar salt seguro:
openssl rand -hex 32
# Copie a saída para ANON_HASH_SALT no .env
```

Editar `docker-compose.yml` para refletir o domínio de produção:

```yaml
environment:
  - COOKIE_DOMAIN=einburgerungstest.gatherpause.com   # NÃO mais .cloudintrip.com
  - ALLOWED_ORIGINS=https://einburgerungstest.gatherpause.com
```

### 4. Subir container

```bash
cd /home/cloudin/backend-einb
docker-compose up -d --build
docker logs einb-backend                    # ver startup
curl http://127.0.0.1:8001/api/health      # responde?
```

### 5. Nginx server block

`/etc/nginx/sites-available/einburgerungstest.conf`:

```nginx
# Inicialmente sem HTTPS (certbot adiciona depois)
server {
    listen 80;
    listen [::]:80;
    server_name einburgerungstest.gatherpause.com;
    root /var/www/html/einburgerungstest;
    index index.html;

    # Conteúdo estático
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Arquivos JSON e dados — sem cache no browser (são versionados manualmente)
    location /data/ {
        add_header Cache-Control "no-cache" always;
    }
    location /i18n/ {
        add_header Cache-Control "no-cache" always;
    }

    # Imagens — cache 1 dia
    location /images/ {
        expires 1d;
        add_header Cache-Control "public, max-age=86400";
    }

    # Backend proxy
    location /api/ {
        proxy_pass http://127.0.0.1:8001/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 60s;
    }

    # Segurança básica (CDN adicionará HSTS, CSP completos)
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    access_log /var/log/nginx/einburgerungstest_access.log;
    error_log /var/log/nginx/einburgerungstest_error.log;
}
```

Ativar:

```bash
sudo ln -s /etc/nginx/sites-available/einburgerungstest.conf \
           /etc/nginx/sites-enabled/einburgerungstest.conf
sudo nginx -t
sudo systemctl reload nginx
```

### 6. HTTPS via Let's Encrypt

**Pré-requisito:** DNS deve já estar apontado (`dig +short einburgerungstest.gatherpause.com` retorna `178.105.184.172`).

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d einburgerungstest.gatherpause.com
# Email: pri@gatherpause.com
# Aceita termos
# Permitir redirect HTTP→HTTPS
```

Certbot edita o nginx.conf adicionando o bloco `listen 443 ssl`.

Verificar renovação automática:

```bash
sudo certbot renew --dry-run
```

### 7. Atualizar webhook do Stripe

Na dashboard Stripe:

1. Developers → Webhooks → endpoint atual (do dev) → **Edit URL**
2. Trocar para: `https://einburgerungstest.gatherpause.com/api/webhooks/stripe`
3. **Salvar.**

Não precisa criar webhook novo — só atualizar URL. O secret (`whsec_`) continua o mesmo.

### 8. Smoke test final

```bash
B="https://einburgerungstest.gatherpause.com"
curl -sS "$B/api/health"
curl -sS "$B/" | head -5

# Registro test
rm -f /tmp/cj.txt
curl -sS -c /tmp/cj.txt -X POST "$B/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d '{"email":"deploy-test@gatherpause.com","password":"TestPass99X","age":30,"nationality":"Test","sex":"M"}'
curl -sS -b /tmp/cj.txt "$B/api/auth/me"
```

Browser: abrir o site, escolher idioma, fazer cadastro completo, clicar pagar, finalizar com cartão teste `4242 4242 4242 4242`, verificar ativação.

### 9. Backups e cron

Ver [OPERATIONS.md](OPERATIONS.md#backups) — copiar o script `einb-backup.sh` para `/etc/cron.daily/`.

---

## Trocar chaves TEST → LIVE

Após validar tudo em teste:

### 1. Na dashboard Stripe (modo Live)

1. **Switch para Live mode** (toggle canto superior direito).
2. **Developers → API keys → Create restricted key**
   - Template: **One-time payments**
   - Adicionar: Coupons (Read), Promotion Codes (Read)
   - Nome: `einburgerungstest-prod`
   - Copiar a `rk_live_...`
3. **Products → criar produto live** (mesmo nome/preço do test). Copiar `price_live_...`.
4. **Developers → Webhooks → Add endpoint**
   - URL: `https://einburgerungstest.gatherpause.com/api/webhooks/stripe`
   - Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   - Copiar o novo `whsec_live_...` (diferente do test!)
5. **Ativar métodos de pagamento Live:** Settings → Payment methods → ativar Cards, PayPal, SEPA Direct Debit conforme desejado.

### 2. No servidor

```bash
ssh cloudin@178.105.184.172
sudo nano /home/cloudin/backend-einb/.env

# Trocar as 3 linhas:
STRIPE_SECRET_KEY=rk_live_...
STRIPE_PRICE_ID=price_live_...
STRIPE_WEBHOOK_SECRET=whsec_live_...

# Aplicar (sem rebuild, mas precisa --force-recreate pra reler o .env)
cd /home/cloudin/backend-einb
sg docker -c "docker-compose up -d --force-recreate"
```

### 3. Validar

```bash
docker logs --tail 20 einb-backend
curl -sS https://einburgerungstest.gatherpause.com/api/health
```

Fazer um pagamento real com cartão próprio (€10) para validar end-to-end. Reembolsar na dashboard depois se quiser recuperar.

### 4. Revogar chave test (limpeza)

Volta no modo test do Stripe → API keys → encontra `einburgerungstest-test` ou `-dev` → **Delete key**.

---

## Rollback

Se algo der errado em produção:

```bash
ssh cloudin@178.105.184.172
cd /home/cloudin/backend-einb

# Parar
docker-compose down

# Voltar para versão anterior do código
cd app && git checkout HEAD~1 -- *.py   # se versionado em git
# OU restaurar de um backup

# Subir
cd .. && docker-compose up -d --build
```

Nginx: se o config quebrou, `sudo nginx -t` mostra o erro. Restore via `sudo cp /etc/nginx/sites-available/einburgerungstest.conf.bak.<timestamp> /etc/nginx/sites-available/einburgerungstest.conf && sudo systemctl reload nginx`.

DB SQLite corrupto: restaurar do backup diário.

```bash
docker-compose down
cp /home/cloudin/backups/einb-AAAAMMDD.sqlite.gz .
gunzip einb-AAAAMMDD.sqlite.gz
docker-compose run --rm backend sh -c "cp /tmp/einb-AAAAMMDD.sqlite /srv/data/einb.sqlite"
docker-compose up -d
```

---

## Migração de dados do dev → prod

Se quiser **levar os usuários reais** que testaram no dev:

```bash
# No dev
ssh -p 2222 cloudin@10.0.10.200 "docker exec einb-backend sqlite3 /srv/data/einb.sqlite '.backup /srv/data/migrate.sqlite'"
ssh -p 2222 cloudin@10.0.10.200 "docker cp einb-backend:/srv/data/migrate.sqlite ~/migrate.sqlite"
scp -P 2222 cloudin@10.0.10.200:~/migrate.sqlite /tmp/migrate.sqlite

# Pra prod
scp /tmp/migrate.sqlite cloudin@178.105.184.172:~/migrate.sqlite
ssh cloudin@178.105.184.172
cd /home/cloudin/backend-einb
docker-compose down
mv data/einb.sqlite data/einb-empty.sqlite          # guarda o vazio
cp ~/migrate.sqlite data/einb.sqlite
docker-compose up -d
```

⚠️ **Atenção:** sessões (cookies) não migram — usuários precisam re-logar. E os cookies `einb_anon` também ficam órfãos (mas é só anti-abuse, sem dor pro usuário legítimo).
