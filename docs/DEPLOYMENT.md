# Deployment (GitHub Actions → AWS EC2 + Cloudflare Pages)

| Part | Hosted on | Workflow | Runs when |
| --- | --- | --- | --- |
| Backend, MQTT broker, PostgreSQL | One AWS EC2 server, Docker Compose (`deploy/aws/`) | `.github/workflows/backend.yml` | Push or PR touching `backend/` or `deploy/aws/` |
| Admin web | Cloudflare Pages | `.github/workflows/admin-web.yml` | Push or PR touching `admin-web/` |

Pull requests only test and build. Pushes to `main` also deploy. Both workflows can be started by hand from the Actions tab.

A longer step-by-step version is in the "Smart Water on AWS" guide.

## How a backend deploy works

1. Typecheck and run the tests. On pull requests, also check that the Docker image builds.
2. Build `backend/Dockerfile` and push it to GitHub Container Registry as `ghcr.io/<owner>/swm-backend:<commit>` and `:latest`.
3. SSH to the server, copy `deploy/aws/docker-compose.yml` and `Caddyfile` to `~/swm`, set `BACKEND_IMAGE` in `~/swm/.env`, pull and restart. `docker compose up --wait` waits for the image's health check (API, database and MQTT broker all up), for up to 5 minutes.
4. Poll `BACKEND_URL/health` from outside until it returns 200 (up to 4 minutes), which also proves Caddy and HTTPS work.

Container logs are rotated (5 × 10 MB per container), so they can't fill the disk.

Secrets live only in `~/swm/.env` on the server. Database data and HTTPS certificates live in Docker volumes and survive deploys.

## One-time setup

### 1. EC2 server

- Ubuntu 24.04, `t3.small` (or `t3.micro` with swap), 20 GiB gp3, an Elastic IP.
- Security group: 22, 80, 443 and 1883 (TCP) from anywhere. SSH must be reachable by GitHub's runners; password login is off on Ubuntu images, so only the key works.
- Install Docker and add swap:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

- Create `~/swm/.env` (log out and back in first so the docker group applies):

```bash
mkdir -p ~/swm && cd ~/swm
cat > .env <<EOF
DOMAIN=13-233-10-20.sslip.io
JWT_SECRET=$(openssl rand -hex 48)
MQTT_SERVICE_PASSWORD=$(openssl rand -hex 24)
DB_PASSWORD=$(openssl rand -hex 24)
SEED_DEMO=true
CORS_ORIGINS=https://swm-admin.pages.dev
EOF
chmod 600 .env
```

`DOMAIN` can be your own domain or the free `<ip-with-dashes>.sslip.io` name.

### 2. Cloudflare Pages

The workflow creates the Pages project (named by `CLOUDFLARE_PAGES_PROJECT`) on its first run, so you only need an API token: dash.cloudflare.com → My Profile → API Tokens → *Create token* with *Account → Cloudflare Pages → Edit*. Your account ID is on the Workers & Pages overview page. React Router routes work without extra config: Pages serves `index.html` for unknown paths when the site has no `404.html`.

### 3. GitHub repository settings

Settings → Secrets and variables → Actions:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `EC2_HOST` | Elastic IP, e.g. `13.233.10.20` |
| Secret | `EC2_SSH_KEY` | Full contents of `swm-key.pem` |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| Variable | `BACKEND_URL` | `https://13-233-10-20.sslip.io` (no trailing slash) |
| Variable | `CLOUDFLARE_PAGES_PROJECT` | `swm-admin` |
| Variable | `EC2_USER` | Optional, defaults to `ubuntu` |

`GITHUB_TOKEN` is used automatically to push and pull the image. `BACKEND_URL` is baked into the admin web build, so after changing it re-run the **Admin web** workflow.

## Pointing the clients at the server

| Part | Setting | Value |
| --- | --- | --- |
| ESP meter | `firmware/smart_water_meter/config.h` → `MQTT_HOST` | The Elastic IP. Re-upload the sketch. |
| Mobile app | `mobile_app/env/lan.json` | `https://<DOMAIN>/api/v1` and `https://<DOMAIN>`. Rebuild the APK. |
| Admin web | GitHub variable `BACKEND_URL` | `https://<DOMAIN>` |

## Rolling back

Every deploy is tagged with its commit. On the server:

```bash
cd ~/swm
sed -i '/^BACKEND_IMAGE=/d' .env && echo "BACKEND_IMAGE=ghcr.io/<owner>/swm-backend:<older-commit-sha>" >> .env
docker compose up -d
```

If the repository is private, run `docker login ghcr.io` first with a token that has `read:packages`.

## Limits to know about

- MQTT on 1883 is unencrypted. For real use, enable the backend's TLS listener on 8883 (`MQTT_TLS_KEY`, `MQTT_TLS_CERT`) and switch the ESP to `WiFiClientSecure`.
- No automatic database backups. Add an EBS snapshot schedule (EC2 → Lifecycle Manager) or a `pg_dump` cron job.
- The AWS Free plan ends after 6 months or when the credits run out. Upgrade the account before then to keep the server.
