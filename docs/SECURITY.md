# Təhlükəsizlik modeli

## Etimad zənciri

1. **PC qeydiyyatı.** Companion ilk dəfə serverə qoşulanda `hostId` + təsadüfi `hostToken` (32 bayt) alır. Server yalnız token-in SHA-256 hash-ini saxlayır. PC-də token DPAPI (`safeStorage`) ilə şifrələnir. Server `PR_REGISTRATION_KEY` ilə yalnız sizin PC-lərinizə qeydiyyat açıq saxlaya bilər.
2. **Pairing kodu (qısa ömürlü).** `crypto.randomInt(0, 10^8)` → 8 rəqəm, string kimi (öndəki sıfırlar qalır). Default ömür 120 s (`PR_PAIRING_TTL_SEC`). Bir PC-nin eyni anda bir kodu olur; yeni kod köhnəni ləğv edir. Aktiv kodlar arasında toqquşma yoxlanılır. Kod **iddia edildiyi anda yanır** (host rədd etsə də).
3. **Host təsdiqi.** Telefon Android Keystore-da EC P-256 açar yaradır (ixrac olunmur) və public key-i göndərir. PC-də (panel və companion) "yeni telefon" sorğusu **açar ID-si** ilə (`SHA-256(SPKI)` ilk 8 hex, məs. `555D-E69C`) göstərilir; telefon da eyni ID-ni göstərir. Uyğun gəlməsə — rədd edin (server açarı dəyişdirməyə cəhd edib).
4. **Uzunmüddətli credential-lar.**
   - Telefon: `deviceToken` (signaling üçün) Keystore AES-GCM açarı ilə şifrələnir; identifikasiya açarı Keystore-dan çıxmır. `allowBackup=false`, backup/transfer qaydalarında istisna.
   - PC: host identifikasiya açarı (EC P-256), cihaz siyahısı, plugin token hash-ləri — DPAPI ilə şifrələnmiş `vault.bin`.
5. **Hər sessiyada qarşılıqlı autentifikasiya (end-to-end).** Data channel açılanda host `hostNonce` göndərir. Telefon imzalayır:
   `PREMIERE-REMOTE-AUTH-V1|device|hostId|deviceId|sessionId|hostNonce|deviceNonce|hostDTLSfp|deviceDTLSfp`
   Host pairing zamanı pin edilmiş açarla yoxlayır, sonra öz açarı ilə `…|host|…` transkriptini imzalayır, telefon da yoxlayır. DTLS fingerprint-lər transkriptdə olduğu üçün **signaling serveri SDP-ni dəyişib MITM edə bilməz** — imza uyğun gəlməz. Autentifikasiyadan əvvəl media track-ləri qoşulmur (`replaceTrack` yalnız uğurdan sonra) və heç bir komanda/input emal olunmur.
6. **İcazələr.** Hər cihaz üçün ayrıca: *view* (həmişə) və *control* (təsdiqdə seçilir, sonra dəyişdirilə bilər — canlı sessiyaya dərhal tətbiq olunur). *Unattended* — opt-in; söndürülübsə hər qoşulma PC-də təsdiq tələb edir.
7. **Ləğv (revoke).** PC-də "Revoke" → yerli siyahıdan silinir, serverdə token silinir, aktiv sessiya bitir, telefonun WS-i `4003` ilə bağlanır. PC həqiqət mənbəyidir: serverdə olub PC-də olmayan cihazlar qoşulanda `devices.sync` ilə silinir.
8. **Stop.** Panel/companion/tray-də "Stop remote access" signaling bağlantısını tamamilə kəsir — PC internetdən heç bir sorğu qəbul etmir.

## Brute-force

- Hər IP: dəqiqədə 10 cəhd (burst 5); 5 səhv → 1 dəq kilid, 10 → 2 dəq, … maksimum 1 saat.
- Qlobal: dəqiqədə 300-dən çox səhv kod → bütün claim-lər 60 s bağlanır (paylanmış enumerasiyaya qarşı).
- Səhv / vaxtı keçmiş / istifadə olunmuş kod üçün **eyni cavab** (`404 expired`) — oracle yoxdur.
- Hesab: qlobal limitlə 120 s ərzində ən çox ~600 təxmin → bir aktiv kodu tapmaq ehtimalı ≈ 600 / 10⁸ = **6·10⁻⁶**. Tapsa belə, PC-də açar ID-li təsdiq lazımdır.
- Qeyd: qlobal limit DoS imkanı yaradır (hücumçu pairing-i müvəqqəti bloklaya bilər) — şəxsi deployment üçün məqbul kompromis; `PR_REGISTRATION_KEY` hostları qoruyur, pairing isə yalnız bu anda kod göstərən PC-yə aiddir.

## Lokal plugin ↔ companion

- **UXP manifest-də `"network": { "domains": "all" }`.** Daha dar siyahı (`["ws://127.0.0.1:47631"]`) Premiere 26.5.2-də sınandı və "Permission denied … Manifest entry not found" xətası verdi. Bu, Adobe forumunda bilinən problemdir və yeganə işlək forma `"all"`-dur. Nəticə: UXP səviyyəsində panel istənilən ünvana qoşula *bilər*. Amma panel kodunda yeganə ünvan sabit `ws://127.0.0.1:47631`-dir, istifadəçi daxiletməsindən URL qurulmur. Adobe dar siyahını düzəldəndə manifest daraldılmalıdır.
- `ws://127.0.0.1:47631` — yalnız loopback.
- `Origin: http(s)://…` başlığı olan bağlantılar rədd edilir (brauzerdəki saytlar qoşula bilmir).
- Qarşı prosesin icra faylı yoxlanılır (`Get-NetTCPConnection` → PID → yol), default icazə siyahısı: `Adobe Premiere Pro.exe`.
- İlk qoşulmada PC-də native dialoq ("Allow the Premiere Remote panel to connect?"); təsdiqdən sonra təsadüfi token (UXP `secureStorage`-də; companion yalnız hash saxlayır).

## Telefondan gələn əmrlər

- İxtiyari shell əmri **yoxdur**. Yalnız kataloqdakı komandalar (`shared/src/commands.js`), validasiya olunmuş arqumentlər.
- Klaviatura: `Win`/`Meta` kombinasiyaları və `Ctrl+Alt+Del` qadağandır; mətn ≤500 simvol; default olaraq yalnız Premiere fokusda olduqda.
- Mouse: default olaraq yalnız Premiere pəncərələrinin üzərində (`WindowFromPoint` → proses yoxlaması).
- *Control* icazəsi = Premiere üzərində klaviatura/mouse idarəsi. Premiere-in öz dialoqları (məs. "Export" fayl seçimi) vasitəsilə fayl sisteminə çıxış mümkündür — yalnız etibar etdiyiniz telefona control verin.

## Kim nəyi görür

| Tərəf | Görür | Görmür |
|---|---|---|
| **Signaling server** | host/device ID-ləri, cihaz adları, IP-lər, bağlantı vaxtları, SDP və ICE namizədləri (IP-lər, codec-lər, DTLS fingerprint-lər), pairing kodları (yalnız yaddaşda hash kimi, loglanmır) | Video, səs, klik/komanda məzmunu (DTLS-SRTP / SCTP-DTLS ilə şifrəli). MITM cəhdi imza yoxlamasında aşkarlanır. |
| **TURN serveri** | Relay olunan trafikin həcmi, vaxtı, hər iki tərəfin IP-si | Məzmun (end-to-end şifrəli paketlər ötürür) |
| **Loglar** | Hadisələr, ID-lər | Kodlar, token-lər, SDP, imzalar (`redact()`; 8 rəqəmli ardıcıllıqlar da maskalanır). Lokal E2E testində yoxlanıldı: loglarda kod/token/SDP 0 dəfə. |

## Məlum qalıq risklər

- İlk pairing TOFU-dur: açar ID-lərini müqayisə etməsəniz, zərərli server özünü PC kimi təqdim edə bilər (yalnız sizə ekran göndərə bilər, PC-yə çıxış əldə etmir).
- Bu layihə müstəqil təhlükəsizlik auditindən keçməyib.
