#!/usr/bin/env bash
# Deploy AutoStore AI / Operator to a Google Compute Engine VM.
#
#   ./deploy-gcloud.sh              # create (or update) the VM and deploy
#
# Why a VM and not Cloud Run: the agent browser is a persistent, logged-in
# Chromium plus a background agent loop. Cloud Run's filesystem is wiped on
# every restart, so the agent's logins would keep vanishing. A VM keeps the
# profile on a real disk — same behaviour as running locally.
#
# Cost: e2-small (2 GB) ≈ $13/month + pennies for the 10 GB disk. If Chromium
# feels tight:  gcloud compute instances set-machine-type $VM --machine-type=e2-medium --zone=$ZONE
set -euo pipefail

VM=autostore-agent
ZONE=us-west1-b
REGION=us-west1
MACHINE=e2-small
REPO=https://github.com/maxvbuda/store.git
TAG=autostore-web

echo "== project: $(gcloud config get-value project 2>/dev/null) =="

gcloud services enable compute.googleapis.com --quiet

# Static IP, so the URL survives VM stop/start.
if ! gcloud compute addresses describe "$VM-ip" --region "$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$VM-ip" --region "$REGION"
fi
IP=$(gcloud compute addresses describe "$VM-ip" --region "$REGION" --format='value(address)')
echo "== static IP: $IP =="

# The app port, open to the world. APP_PASSWORD is the gate — the deploy
# refuses to finish without one (see below).
if ! gcloud compute firewall-rules describe allow-$TAG >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-$TAG \
    --allow tcp:8787 --target-tags $TAG --direction INGRESS
fi

# Everything below runs on the VM as root at first boot.
STARTUP=$(mktemp)
cat > "$STARTUP" <<'EOS'
#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y nodejs npm python3 python3-pip git curl

id -u store >/dev/null 2>&1 || useradd -m -d /opt/store -s /bin/bash store
mkdir -p /opt/store && chown store:store /opt/store

if [ ! -d /opt/store/store/.git ]; then
  sudo -u store git clone --depth 1 https://github.com/maxvbuda/store.git /opt/store/store
else
  sudo -u store git -C /opt/store/store pull --ff-only
fi

cd /opt/store/store
sudo -u store npm install --no-audit --no-fund
pip3 install --break-system-packages -r requirements.txt
# System libraries Chromium needs (root), then the browser itself into the
# repo-local dir lib/browser.js auto-detects.
python3 -m playwright install-deps chromium
sudo -u store env PLAYWRIGHT_BROWSERS_PATH=/opt/store/store/.playwright \
  python3 -m playwright install chromium

cat > /etc/systemd/system/autostore.service <<'EOF'
[Unit]
Description=AutoStore AI agent server
After=network-online.target
Wants=network-online.target

[Service]
User=store
WorkingDirectory=/opt/store/store
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now autostore
EOS

if gcloud compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
  echo "== VM exists — re-running the startup script (pulls latest main) =="
  gcloud compute instances add-metadata "$VM" --zone "$ZONE" \
    --metadata-from-file startup-script="$STARTUP"
  gcloud compute ssh "$VM" --zone "$ZONE" --command \
    'sudo google_metadata_script_runner startup'
else
  gcloud compute instances create "$VM" \
    --zone "$ZONE" --machine-type "$MACHINE" \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 10GB --tags $TAG \
    --address "$IP" \
    --metadata-from-file startup-script="$STARTUP"
fi
rm -f "$STARTUP"

echo "== waiting for SSH =="
for i in $(seq 1 30); do
  gcloud compute ssh "$VM" --zone "$ZONE" --command 'true' >/dev/null 2>&1 && break
  sleep 10
done

# ---- environment ----------------------------------------------------------
# Built from the local .env. The VM is on a public IP, so an APP_PASSWORD is
# not optional: without it /api/llm is an open proxy against your key.
if [ ! -f .env ]; then echo "no local .env found — run from the repo root"; exit 1; fi
VMENV=$(mktemp)
grep -v '^APP_PASSWORD=' .env > "$VMENV"
PASS=${APP_PASSWORD:-$(openssl rand -hex 8)}
echo "APP_PASSWORD=$PASS" >> "$VMENV"

gcloud compute scp "$VMENV" "$VM":/tmp/store.env --zone "$ZONE"
gcloud compute ssh "$VM" --zone "$ZONE" --command \
  'sudo mv /tmp/store.env /opt/store/store/.env && sudo chown store:store /opt/store/store/.env && sudo chmod 600 /opt/store/store/.env'
rm -f "$VMENV"

echo "== waiting for the app (first boot installs Chromium — a few minutes) =="
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$IP:8787/api/status" || true)
  [ "$code" = 200 ] && break
  sleep 10
done

echo
echo "======================================================"
echo "  URL          : http://$IP:8787"
echo "  gate password: $PASS   (save this — it unlocks the app)"
echo "  logs         : gcloud compute ssh $VM --zone $ZONE --command 'sudo journalctl -u autostore -f'"
echo "  redeploy     : ./deploy-gcloud.sh   (pulls latest main)"
echo "======================================================"
