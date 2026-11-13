# DerpibooruMirror

[English](README.md) | [简体中文](README_zh_CN.md) | [繁體中文](README_zh_TW.md)

**目錄：** [專案介紹](#專案介紹) · [架構與原理](#架構與原理) · [編譯與測試](#編譯與測試) · [部署與執行](#部署與執行) · [隱私與 Cookie 聲明](#隱私與-cookie-聲明)

<a id="專案介紹"></a>

DerpibooruMirror 是專用於 [`https://derpibooru.org`](https://derpibooru.org) 的固定來源反向代理。專案預設使用此上游，安裝相依套件後即可啟動，不需修改上游網址。瀏覽器請求無法指定任意上游 URL。建議僅供私人使用，或在入口設定存取控制，避免成為開放代理。

支援串流回應、媒體 `Range`/`206`/`416`、WebSocket，以及有限大小的 HTML/CSS/JSON URL 重寫；Anubis 配接器要求版本完全相符；未知版本不會啟用專用重新導向映射（fail-closed），也不會自動切換配接器。

<a id="架構與原理"></a>

## 架構與原理

瀏覽器連線至 `client.origin`。伺服器檢查 Host 標頭後，由 `ClientGateway` 建立請求內容，再將固定路由交給 `UpstreamGateway`。後者呼叫 `ProxyEngine`，完成上游請求轉送與回應傳輸。二進位回應採串流傳輸，URL 重寫僅處理已知上游網址，並限制可重寫的回應大小。

`SessionManager` 為每個代理工作階段及上游來源（origin） 建立獨立的記憶體 CookieJar（由 `tough-cookie` 提供）。一般上游 Cookie 只在工作階段有效期間暫存於此記憶體容器，供後續請求維持登入狀態，絕不寫入磁碟。Anubis Cookie 主要由用戶端瀏覽器持有，代理只向相符工作階段轉發已辨識的 Cookie，並保留名稱及屬性摘要供路由與診斷使用。

診斷日誌元件可記錄請求 ID、流程 ID、狀態碼、Content-Type，以及 Cookie 名稱與屬性摘要；它會排除憑證相關標頭，並遮蔽已知的敏感查詢欄位。預設的 `npm start` 入口未接入逐筆請求日誌。自行串接日誌時，應使用專案提供的敏感資料遮蔽工具，避免直接輸出標頭、請求本文或請求內容物件。

<a id="編譯與測試"></a>

## 編譯與測試

需要 Git、Node.js 22 或更新版本，以及 npm。安裝相依套件時需要連線至 npm 套件庫；執行代理時需要連線至 `derpibooru.org`。

```sh
git clone https://github.com/kerybotu/DerpibooruMirror.git
cd DerpibooruMirror
npm ci
npm test
npm run test:coverage
git diff --check
```

本專案沒有獨立編譯步驟，Node.js 直接執行儲存庫中的 ES 模組；`npm ci` 依鎖定檔安裝相依套件。測試使用本機測試服務與資料，不代表線上 Derpibooru 認證已成功。

<a id="部署與執行"></a>

## 部署與執行

將 `config/config.example.json` 複製到私有設定檔，再以 `MIRROR_CONFIG` 指定：

```sh
cp config/config.example.json config.local.json
MIRROR_CONFIG="$PWD/config.local.json" npm start
```

啟動前請編輯 `config.local.json`，並將它排除於版本控制之外。Windows PowerShell 使用者可先執行 `$env:MIRROR_CONFIG = (Resolve-Path ./config.local.json).Path`，再執行 `npm start`。監聽與上游設定從 JSON 讀取，不支援透過 `SERVER_HOST` 或 `UPSTREAM_ORIGIN` 環境變數覆寫。

預設監聽 `127.0.0.1:3000`，預設上游為 `https://derpibooru.org`，TLS 驗證必須為 `true`。自訂上游仍需明確設定 `ALLOW_CUSTOM_UPSTREAM=1`，且不可關閉 TLS 驗證。`client.origin` 必須與瀏覽器使用的 Host 及協定一致。

正式環境建議讓 Node 僅監聽本機回環介面，由現有 Nginx、Caddy 或 Cloudflare Tunnel 終止 HTTPS。應用程式沒有內建 `/healthz`。預設設定可用 `curl -I http://127.0.0.1:3000/` 檢查連線。如果 `client.origin` 改為 `https://mirror.example.com`，請改用 `curl -I -H "Host: mirror.example.com" http://127.0.0.1:3000/`；Host 不符會回傳 421。收到 HTTP 回應僅表示連線可達，仍須核對狀態碼並透過瀏覽器驗證認證流程。systemd 或 PM2 均可使用專用無特權帳號、受限日誌及相同的 `MIRROR_CONFIG` 環境變數執行。

<a id="隱私與-cookie-聲明"></a>

## 隱私與 Cookie 聲明

本服務端僅作為反向代理轉發層。工作階段有效期間，一般上游 Cookie 會由 `SessionManager` 按工作階段、按上游來源 暫存於服務端記憶體 CookieJar，用於維持代理工作階段；此快取不會持久化至磁碟。Anubis Cookie 主要由用戶端瀏覽器持有。

服務端不會將 Cookie、認證憑據、Token、Authorization 或其他敏感憑據持久化到磁碟；Cookie 值及敏感憑據不會寫入診斷日誌或主控台，只保留路由所需的名稱及屬性摘要。除工作階段轉發所需的記憶體快取外，本服務不作長期儲存或資料收集。上游處理的資料適用 [Derpibooru](https://derpibooru.org) 官方 Cookie 與隱私政策。部署者仍須對經過代理的資料，以及自身主機與基礎設施日誌負責；上游政策無法取代部署者應提供的說明。

## 授權條款

MIT，詳見 [LICENSE](LICENSE)。
