#!/bin/bash
# Once, on a server set up before WhatsApp: agents-update also installs the app's libraries from now on.
# Run after `sudo agents-update`:   sudo bash /opt/agents/webservice/agents-app/deploy/upgrade-server.sh
set -euo pipefail
APP_DIR=/opt/agents/webservice
[ "$(id -u)" = 0 ] || { echo "شغّله مع sudo"; exit 1; }

# The branch this server deploys, as the current agents-update has it (or the instance metadata).
BRANCH=$(sed -n 's/.*fetch --depth 1 origin \([^ ]*\).*/\1/p' /usr/local/bin/agents-update 2>/dev/null | head -1)
[ -n "$BRANCH" ] || BRANCH=$(curl -fs -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/app-branch || true)
[ -n "$BRANCH" ] || { echo "لم أجد فرع الموقع"; exit 1; }

command -v npm >/dev/null || apt-get install -y npm

cat > /usr/local/bin/agents-update <<EOS
#!/bin/bash
set -e
git -C $APP_DIR fetch --depth 1 origin $BRANCH
git -C $APP_DIR reset --hard FETCH_HEAD
(cd $APP_DIR/agents-app && npm ci --omit=dev --no-audit --no-fund) || echo "⚠ npm ci failed: the site is updated, WhatsApp may stay off"
systemctl restart agents-app
echo "Updated to \$(git -C $APP_DIR log -1 --format='%h %s')"
EOS
chmod 755 /usr/local/bin/agents-update
echo "✔ agents-update يثبّت المكتبات من الآن (الفرع: $BRANCH)"
/usr/local/bin/agents-update
