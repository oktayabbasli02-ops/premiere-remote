# Server deployment (signaling + TURN)

## Nə lazımdır

- Kiçik Linux VPS (1 vCPU, 1–2 GB RAM kifayətdir), public IPv4.
- Domen: məsələn `signal.example.com` və `turn.example.com` → VPS IP-si (A record).
- Docker + Docker Compose.
- Firewall-da açıq portlar: TCP 80, 443 (Caddy/TLS), TCP+UDP 3478 (TURN), TCP 5349 (TURNS), UDP 49160–49660 (relay).

## Addımlar

```bash
git clone <repo> premiere-remote && cd premiere-remote/deploy
cp .env.example .env                    # PR_DOMAIN, PR_REGISTRATION_KEY, PR_TURN_SECRET, PR_TURN_URLS
cp turnserver.conf.example turnserver.conf
openssl rand -hex 32                    # eyni dəyəri .env-də PR_TURN_SECRET və turnserver.conf-da static-auth-secret
docker compose up -d --build
curl https://signal.example.com/healthz # {"ok":true,"v":1}
```

Sonra companion-da: **Server URL** = `https://signal.example.com`, **Registration key** = `.env`-dəki `PR_REGISTRATION_KEY`.

TURN-u yoxlamaq: <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/> səhifəsində `turn:turn.example.com:3478` + müvəqqəti credential (serverin verdiyi formatda) ilə `relay` namizədi görünməlidir. Daha sadə: telefonu mobil dataya keçirib Stats-da **Path: TURN relay** və ya **direct** görmək.

## Lokal inkişaf (TLS-siz, yalnız loopback)

```bash
cd server
npm install
node --env-file=.env.example src/index.js     # http://127.0.0.1:8787
```

Companion `http://127.0.0.1:8787` və ya `http://localhost:8787` qəbul edir (yalnız loopback üçün `http`). Android emulyatoru üçün `http://10.0.2.2:8787` (network security config yalnız bu ünvanlara cleartext icazə verir). Real telefon həmişə `https://` tələb edir.

## Xərc təxmini (yoxlanılmalı — qiymətlər dəyişir)

| Maddə | Təxmini |
|---|---|
| VPS (signaling + coturn) | ayda ~4–6 USD/EUR (Hetzner, DigitalOcean, Vultr səviyyəsində ən kiçik plan) |
| Domen | ildə ~10 USD |
| TURN trafiki | Yalnız birbaşa əlaqə mümkün olmadıqda istifadə olunur (mobil operatorların CGNAT-ında tez-tez lazım olur). 720p30 profil ~2.5 Mbit/s ≈ **~1.1 GB/saat** (relay hər iki istiqamətdə sayıla bilər). Bir çox VPS planına aylıq 1–20 TB trafik daxildir. |
| Alternativ: idarə olunan TURN (Cloudflare, Twilio və s.) | GB başına ödəniş; trafik az olarsa sərfəli ola bilər |

## Üçüncü tərəf lisenziyaları

| Komponent | Lisenziya | Harada |
|---|---|---|
| Electron / Chromium | MIT / BSD-3 + Chromium-un üçüncü tərəf lisenziyaları | companion |
| OpenH264 (Chromium daxilində) | BSD-2. **H.264 patent lisenziyası** Cisco-nun öz binary-lərini əhatə edir; Chromium mənbədən qurur — kommersiya paylanmasında patent məsələsini hüquqşünasla yoxlayın. VP8 royalty-free alternativdir. | companion |
| ws | MIT | server, companion |
| koffi | MIT | companion |
| qrcode-generator | MIT | companion, panel (`vendor/`) |
| electron-builder | MIT | build tool |
| io.github.webrtc-sdk:android (libwebrtc) | BSD-3 | Android |
| OkHttp | Apache-2.0 | Android |
| AndroidX / Jetpack Compose / kotlinx.coroutines | Apache-2.0 | Android |
| coturn | BSD-3 | server |
| Caddy | Apache-2.0 | server |
| @adobe/premierepro (yalnız tip yoxlaması, paylanmır) | Apache-2.0 | tools |
| Adobe Premiere Pro / UXP | Adobe-un öz şərtləri | host proqram |
