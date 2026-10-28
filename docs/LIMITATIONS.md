# Host tələbləri və OS davranışı

## Ev PC-si nə vaxt işləyir

| Şərt | Lazımdır |
|---|---|
| PC yanılı, yuxu rejimində deyil | Bəli. "Remote access" aktiv olduqda companion ekranın sönməsinin qarşısını alır (`powerSaveBlocker: prevent-display-sleep`, ayarda söndürülə bilər). PC yuxuya gedərsə sessiya bitir; Wake-on-LAN dəstəklənmir. |
| İnternet | Bəli. Router port-forwarding **lazım deyil** (WebRTC ICE + TURN). |
| Companion işləyir | Bəli (tray-də). |
| Premiere açıqdır | Video üçün yox (display rejimi), redaktə üçün bəli. |
| Premiere Remote paneli açıqdır | API komandaları üçün bəli (Save, kadr addımı, In/Out, marker, delete, mute, status, split yoxlaması). Panel dock-da kiçik qala bilər. |
| Monitor | Fiziki monitor bağlı olmalıdır və ya HDMI "dummy plug"/virtual display istifadə olunmalıdır. Monitorsuz Windows bəzən 1024×768 virtual ekran yaradır və ya tutma dayanır. |

## Windows vəziyyətləri

| Vəziyyət | Davranış |
|---|---|
| **Windows kilidlidir** | Kilid ekranı secure desktop-dur: tutma ya donur, ya qara olur; **input göndərilmir** (companion `lock-screen` hadisəsini görür, telefona "Windows is locked" yazır). Kilidi açmaq üçün PC başında olmaq lazımdır — bypass edilmir. |
| **Yuxu / hibernasiya** | Sessiya bitir (`suspend` hadisəsi). Oyandıqdan sonra companion yenidən qoşulur, telefon yeni sessiya istəyir. |
| **UAC / elevated pəncərə** | UAC secure desktop-da görünür — tutulmur və idarə olunmur. Administrator kimi işləyən proqramlara SendInput UIPI tərəfindən bloklanır. Companion `asInvoker` işləyir və bunu dəyişmir. |
| **Premiere minimize edilib** | Pəncərə tutma minimize pəncərəni göstərə bilməz; status "minimized" göstərir; klaviatura komandaları əvvəl pəncərəni bərpa edir. |
| **Premiere-də modal dialoq** | Əsas pəncərə disabled olur → klaviatura komandaları `modal_dialog` xətası ilə **imtina edilir**; telefon dialoqu görüb toxunma ilə bağlaya bilər (dialoq Premiere prosesinə aiddir). |
| **Başqa pəncərə öndədir** | Komandadan əvvəl Premiere öne gətirilir; Windows icazə verməzsə `focus_lost` xətası (yalançı uğur yoxdur). |
| **Windows ön plan kilidi** | Windows bəzən başqa prosesin pəncərəsini öne çəkməyə icazə vermir (məs. fokus emulyator/başqa proqramdadırsa). Real sınaqda bu baş verdi: companion klavişi **göndərmədi** və `focus_lost` qaytardı. Bu kilid bypass edilmir. |
| **Klaviatura düzülüşü** | Shortcut-lar virtual klavişlə göndərilir; Premiere onları aktiv düzülüşlə şərh edir. AZE düzülüşündə `Shift+3` = "№", `W` = "ü" olur, amma bu PC-də `Shift+3` (Timelines) və `=` yenə düzgün işlədi. Başqa düzülüşdə işləməyən shortcut-u `shortcuts.json`-da dəyişin. Bir dəfə izah edilməmiş hal müşahidə olundu: ard-arda 6 Zoom + Premiere-i Audio workspace-ə (Alt+Shift+3) keçirdi. |
| **Premiere-dən kənar klik** | Default olaraq bloklanır (`input_blocked`). Companion-da "Allow phone input outside Premiere windows" aktiv edilərsə icazə verilir. |
| **DPI scaling / çox monitor** | Companion per-monitor-DPI-aware-dir; bütün koordinatlar fiziki pikseldir. Mənfi koordinatlı (soldakı) monitorlar dəstəklənir. |
| **Pəncərə tutma kənar fərqi** | Tutulmuş kadrın nisbəti pəncərə sərhədlərindən >2% fərqlənərsə telefona xəbərdarlıq gedir → display rejiminə keçin. |

## Media

- **Kodlayıcı:** Chromium hardware H.264 (Media Foundation) mövcud olduqda onu, yoxdursa OpenH264 (CPU) istifadə edir. Faktiki kodlayıcı companion və telefon statistikasında göstərilir. İnkişaf PC-sində **OpenH264** seçildi.
- **Səs:** yalnız default səs çıxışının loopback-ı. Default cihaz aktiv deyilsə (məs. söndürülmüş simsiz qulaqlıq) səs tutulmur, video davam edir, telefona bildiriş gedir. Həll: Windows-da aktiv çıxışı default edin.
- **Latency:** heç vaxt "sıfır" deyil. Göstərilən "Network RTT" ICE candidate-pair RTT-dir; "App command RTT" data channel + host emalıdır; **glass-to-glass** (ekrandan ekrana) avtomatik ölçülmür — E2E checklist-də əl ilə ölçmə metodu var.
