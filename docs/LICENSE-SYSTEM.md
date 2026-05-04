# flowiqa.com License System - Server Contract

Bu doküman flowiqa.com tarafının (lisans sunucusu + admin paneli) uyması gereken sözleşmeyi tanımlar. Client tarafı `lib/license.js` bu sözleşmeye göre yazıldı.

## Genel Mimari

```
flowiqa.com (sunucu)               Müşteri makinesi (etsy-product-creator)
────────────────────               ─────────────────────────────────────
DB: licenses tablosu      <─────>  data/license.json (imzalı cache)
Admin panel                        Server boot:  POST /api/license/check
  - kullanıcı listele              UI aktivasyon: POST /api/license/activate
  - status değiştir                Heartbeat 6h:  POST /api/license/check
  - plan / expires                 Grace period:  7 gün offline tolere edilir
  - manuel key üret
ed25519 imza (private key)         ed25519 doğrulama (public key)
```

## Crypto

Server bir ed25519 keypair üretir. Private key sunucuda saklı, **asla** client'a gitmez. Public key client'a gömülü.

Üretim:
```js
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }));
```

Public key client'taki `lib/license.js` içine `SERVER_PUBLIC_KEY_PEM` olarak yazılır (production deploy öncesi).

### İmzalama

Tüm imzalı yanıtlarda:
- `payload`: imzalanacak obje
- `signature`: `ed25519(canonicalJson(payload))` → base64

Canonical JSON: anahtarlar alfabetik sıralı stringify (client `canonicalJson()` ile aynı). Boşluk yok.

```js
const sig = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64');
```

## Endpointler

Tümü `Content-Type: application/json`. Hata yanıtları HTTP status + `{ "error": "<code>" }` döner.

### POST /api/license/activate

İlk aktivasyon. Anahtarı bu makineye (HWID) bağlar.

**Request:**
```json
{
  "app": "etsy-product-creator",
  "email": "user@example.com",
  "key": "FLOW-XXXX-XXXX-XXXX-XXXX",
  "hwid": "abc123..."
}
```

**Response 200:**
```json
{
  "payload": {
    "email": "user@example.com",
    "key": "FLOW-XXXX-XXXX-XXXX-XXXX",
    "hwid": "abc123...",
    "plan": "pro",
    "status": "active",
    "expires": "2026-12-01T00:00:00Z",
    "issuedAt": "2026-05-03T10:00:00Z",
    "app": "etsy-product-creator"
  },
  "signature": "base64-ed25519-signature-of-payload"
}
```

**Response 4xx (`error` kodları):**
- `400` `email_and_key_required` - eksik alan
- `401` `invalid_key` - anahtar bulunamadı
- `409` `hwid_mismatch` - başka makineye bağlı (önce eski makineyi deactivate etmeli)
- `403` `revoked` - admin tarafından iptal
- `403` `expired` - süre dolmuş (ödeme yenilensin)

Server logic:
1. `key` DB'den `licenses` tablosundan bul.
2. `status` ∈ {active}, `expires > now`, `app` eşleşiyor.
3. `hwid` boş veya eşit → güncel HWID'yi yaz, `status = active`.
4. `hwid` farklı → 409 dön (kullanıcı admin panelden veya `/deactivate` ile sıfırlamalı).
5. `payload` üret, imzala, dön.

### POST /api/license/check

Heartbeat. Her 6 saatte bir client çağırır.

**Request:**
```json
{ "app": "etsy-product-creator", "key": "FLOW-...", "hwid": "abc123..." }
```

**Response 200 (active):**
Aktivasyondaki ile aynı şema (`payload` + `signature`). `status: "active"`.

**Response 403 (revoked/expired/hwid):**
```json
{
  "payload": {
    "key": "FLOW-...",
    "hwid": "abc123...",
    "status": "revoked",        // veya "expired", "hwid_mismatch"
    "issuedAt": "2026-05-03T..."
  },
  "signature": "..."
}
```

Önemli: 403 yanıtı da imzalı dönmeli — client cache'i imzalı kanıt olmadan revoke edemez (MITM koruması).

### POST /api/license/deactivate

Kullanıcı kendi makinesinden lisansı çıkarır (başka makineye taşımak için).

**Request:** `{ "key": "FLOW-...", "hwid": "abc123..." }`

**Response 200:** `{ "ok": true }`

Server: `licenses` tablosunda `hwid = NULL` yaz. Bir sonraki `/activate` farklı makinede çalışır.

## DB Şeması (Önerilen)

```sql
CREATE TABLE licenses (
  id           BIGSERIAL PRIMARY KEY,
  key          VARCHAR(64) UNIQUE NOT NULL,    -- FLOW-XXXX-...
  email        VARCHAR(255) NOT NULL,
  app          VARCHAR(64) NOT NULL DEFAULT 'etsy-product-creator',
  plan         VARCHAR(32) NOT NULL DEFAULT 'pro',
  status       VARCHAR(16) NOT NULL DEFAULT 'active',  -- active, revoked, expired
  hwid         VARCHAR(64),                    -- aktivasyon sonrası dolar
  expires      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,                    -- son heartbeat
  last_seen_ip INET,
  notes        TEXT
);

CREATE INDEX idx_licenses_email ON licenses(email);
CREATE INDEX idx_licenses_status ON licenses(status);
```

## Admin Panel Gereksinimleri

- Lisans listesi: email, key, plan, status, hwid, expires, last_seen_at, IP.
- Aksiyonlar:
  - **Pause/Revoke**: `status = revoked` → bir sonraki heartbeat'te client kilitlenir.
  - **Reactivate**: `status = active`.
  - **Reset HWID**: `hwid = NULL` → kullanıcı yeni makineye geçebilir.
  - **Extend**: `expires += N gün` → ödeme uzatma.
  - **Plan değiştir**: free / pro / team.
- Manuel key üretim: `crypto.randomBytes(16)` → base32 → `FLOW-XXXX-XXXX-XXXX-XXXX` formatı.

## Güvenlik Notları

1. **Rate limit**: aktivasyon endpoint'i IP başına dakikada 5 deneme.
2. **HTTPS zorunlu**: client `https://flowiqa.com` bekliyor, HTTP fallback yok.
3. **CORS**: client'ın kendisi server'a doğrudan istek atmıyor (proxy üzerinden), yine de gerekirse aktivasyon endpoint'i için izin ver.
4. **Public key rotation**: 12 ayda bir keypair değiştir → client tarafı da güncelleyen `npm install` zorunlu.
5. **Audit log**: aktivasyon/heartbeat/deactivation event'leri ayrı tabloda tut.

## Test Vektörleri

Client'ın doğru çalıştığını test için sunucu mock'u:

```js
// scripts/license-server-mock.js (geliştirme amaçlı)
const express = require('express');
const crypto = require('crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
console.log('PUBLIC KEY (client'a koy):\n', publicKey.export({ type:'spki', format:'pem' }));

// canonicalJson(...) ile imzala
// /api/license/activate ve /api/license/check endpoint'lerini implement et
```

Geliştirici, client'ın `.env`'inde `FLOWIQA_LICENSE_SERVER=http://localhost:4000` ve `FLOWIQA_LICENSE_PUBKEY=<mock-pubkey-pem>` set ederek bağlanır.

## Client Davranışı (Özet)

| Durum | Client |
|-------|--------|
| Cache yok | `/activate` sayfasına redirect |
| Cache var, status=active, expires geçmemiş, son heartbeat 7 gün içinde | İzin ver |
| Cache var ama signature geçersiz | Reddet (`invalid_signature`) |
| Cache HWID ≠ makine HWID | Reddet (`hwid_mismatch`) |
| 7 günden uzun heartbeat yok | Reddet (`grace_expired`) |
| Server 403 + imzalı revoke payload | Cache'i revoked olarak yaz, reddet |
| Server unreachable, son heartbeat <7 gün | İzin ver (grace) |
| `LICENSE_BYPASS=1` env | İzin ver + warning log (sadece dev) |
