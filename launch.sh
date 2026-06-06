#!/usr/bin/env bash
# Tek tik launcher: update + CDP browser + server + tarayicida ac.
# Masaustu shortcut buna point eder.
#
# Akis:
#   1. release branch'ten guncelleme kontrol et (rollback safe)
#   2. CDP browser cevapsizsa ac, hazir olana kadar bekle
#   3. Server cevapsizsa baslat, hazir olana kadar bekle
#   4. Default tarayicida http://localhost:<port> ac

set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say()  { echo -e "${YELLOW}>> $*${NC}"; }
ok()   { echo -e "${GREEN}   $*${NC}"; }
warn() { echo -e "${RED}   $*${NC}"; }

CDP_PORT=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('config.json')).cdpPort||9333) } catch { console.log(9333) }" 2>/dev/null)
SERVER_PORT="${PORT:-3001}"

# 1. Update check (flowiqa.com tarball)
say "Guncelleme kontrol..."
LOCAL_VERSION=$(cat data/.version 2>/dev/null || echo "")
REMOTE_VERSION=$(curl -sf --max-time 5 "https://www.flowiqa.com/api/version?app=etsy-product-creator-e" 2>/dev/null | node -e "try { let d=''; process.stdin.on('data', c=>d+=c); process.stdin.on('end', ()=>{ try { console.log(JSON.parse(d).version||'') } catch { console.log('') } }) }" 2>/dev/null || echo "")

if [ -n "$REMOTE_VERSION" ] && [ "$LOCAL_VERSION" != "$REMOTE_VERSION" ]; then
  say "Yeni surum mevcut: $LOCAL_VERSION -> $REMOTE_VERSION, guncelleniyor..."
  KEY=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('data/license.json')).payload.key) } catch { console.log('') }" 2>/dev/null)
  if [ -z "$KEY" ]; then
    warn "Lisans cache yok, guncelleme atlandi (/activate'ten sonra tekrar dene)"
  else
    # Re-run installer with stored key — atomik replace, .env/config korunur
    if curl -fsSL "https://www.flowiqa.com/install/etsy-product-creator-e.sh" | TARGET="$(pwd)" bash -s "$KEY" >/tmp/epc-update.log 2>&1; then
      echo "$REMOTE_VERSION" > data/.version
      ok "Guncelleme basarili: $REMOTE_VERSION"
    else
      warn "Guncelleme basarisiz, eski surum ile devam (/tmp/epc-update.log incele)"
    fi
  fi
else
  ok "Guncel${LOCAL_VERSION:+ ($LOCAL_VERSION)}"
fi

# 2. CDP browser
say "CDP browser ($CDP_PORT)..."
if curl -sf --max-time 1 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
  ok "Zaten acik"
else
  say "Aciliyor..."
  nohup npm run browser > /tmp/epc-browser.log 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 30); do
    sleep 0.5
    if curl -sf --max-time 1 "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
      ok "Hazir"
      break
    fi
  done
fi

# 3. Server
say "Server ($SERVER_PORT)..."
if curl -sf --max-time 1 "http://localhost:$SERVER_PORT/" -o /dev/null; then
  ok "Zaten calisiyor"
else
  nohup npm start > /tmp/epc-server.log 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 30); do
    sleep 0.5
    if curl -sf --max-time 1 "http://localhost:$SERVER_PORT/" -o /dev/null; then
      ok "Hazir"
      break
    fi
  done
fi

# 4. Tarayicida ac
URL="http://localhost:$SERVER_PORT"
case "$(uname)" in
  Darwin) open "$URL" ;;
  Linux) xdg-open "$URL" 2>/dev/null || true ;;
esac

echo ""
ok "Hazir: $URL"
echo "   Loglar: /tmp/epc-browser.log + /tmp/epc-server.log"
