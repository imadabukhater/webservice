#!/bin/bash
# Google Compute Engine startup script: installs and runs the agents portal behind Caddy (automatic HTTPS).
# Runs on every boot; each step is skipped when already done. Settings come from instance metadata:
#   app-domain      host name served over HTTPS (e.g. 34-1-2-3.sslip.io)
#   app-branch      git branch to deploy
#   admin-password  first admin password (only used when the database is created)
set -euo pipefail

meta() { curl -fs -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }
DOMAIN=$(meta app-domain)
BRANCH=$(meta app-branch)
REPO=https://github.com/imadabukhater/webservice.git
APP_DIR=/opt/agents/webservice
DATA_DIR=/var/lib/agents-app

export DEBIAN_FRONTEND=noninteractive

# Small machines need swap so npm/apt never run out of memory.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update && apt-get install -y ca-certificates curl gnupg git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

id agents >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin agents
mkdir -p "$DATA_DIR" /opt/agents
chown agents:agents "$DATA_DIR" && chmod 700 "$DATA_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$APP_DIR"
fi

# The admin password is read once, when the database does not exist yet.
if [ ! -f "$DATA_DIR/agents.db" ]; then
  PASS=$(meta admin-password)
  install -m 600 -o root -g root /dev/null /etc/agents-app.env
  if [ -n "$PASS" ]; then echo "ADMIN_PASSWORD=$PASS" > /etc/agents-app.env; fi
else
  : > /etc/agents-app.env
fi

cat > /etc/systemd/system/agents-app.service <<EOF
[Unit]
Description=Agents portal
After=network.target

[Service]
User=agents
WorkingDirectory=$APP_DIR/agents-app
Environment=NODE_ENV=production PORT=3000 DB_FILE=$DATA_DIR/agents.db TRUST_PROXY=1
EnvironmentFile=-/etc/agents-app.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
http://34.56.162.217, hotesim.shop {
  redir https://www.hotesim.shop{uri} permanent
}

www.hotesim.shop, 34-56-162-217.sslip.io {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

# Pulls the latest code of the deployed branch and restarts the app.
cat > /usr/local/bin/agents-update <<EOF
#!/bin/bash
set -e
git -C $APP_DIR fetch --depth 1 origin $BRANCH
git -C $APP_DIR reset --hard FETCH_HEAD
systemctl restart agents-app
echo "Updated to \$(git -C $APP_DIR log -1 --format='%h %s')"
EOF
chmod 755 /usr/local/bin/agents-update

systemctl daemon-reload
systemctl enable --now agents-app
systemctl restart agents-app
systemctl enable caddy
systemctl reload-or-restart caddy
