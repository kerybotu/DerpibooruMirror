# DerpibooruMirror

[English](README.md) | [简体中文](README_zh_CN.md) | [繁體中文](README_zh_TW.md)

**目錄：** [專案介紹](#專案介紹) · [架構與原理](#架構與原理) · [編譯與測試](#編譯與測試) · [部署與執行](#部署與執行) · [隱私與 Cookie 聲明](#隱私與-cookie-聲明)

<a id="專案介紹"></a>

DerpibooruMirror 是專用於 [`https://derpibooru.org`](https://derpibooru.org) 的固定來源反向代理。發行版本預設已設定此上游，下載後不需修改上游網址即可執行。代理不接受瀏覽器提供的任意上游 URL，適合放在私人存取邊界後方，不應作為開放的公共轉發器。

支援串流回應、媒體 `Range`/`206`/`416`、WebSocket，以及有限大小的 HTML/CSS/JSON URL 重寫；Anubis 適配器依精確版本選擇，未知版本維持 fail-closed。

<a id="架構與原理"></a>

## 架構與原理

瀏覽器連線至 `client.origin`，`ClientGateway` 驗證固定路由，`ProxyEngine` 將請求送往固定的 Derpibooru origin，`UpstreamGateway` 再把回應串流傳回瀏覽器。二進位及串流內容不做全文快取，URL 重寫只處理已知上游網址。

`SessionManager` 為每個代理工作階段及上游 origin 建立獨立的記憶體 `tough-cookie CookieJar`。一般上游 Cookie 只在活動工作階段暫存於此記憶體容器，以維持後續代理工作階段，絕不寫入磁碟。Anubis Cookie 主要由用戶端瀏覽器持有，代理只向相符工作階段轉發已辨識的 Cookie，並保留名稱及屬性摘要供路由與診斷使用。

診斷只包含 request/flow ID、狀態碼、Content-Type、Cookie 名稱及屬性摘要。Cookie 值、Authorization、Token、PoW 參數及敏感查詢參數在輸出前均會脫敏。

<a id="編譯與測試"></a>

## 編譯與測試

需要 Node.js 22 或更新版本，並能連線 npm registry 及 `derpibooru.org`。

```sh
git clone https://github.com/kerybotu/DerpibooruMirror.git
cd DerpibooruMirror
npm ci
npm test
npm run test:coverage
git diff --check
```

本專案沒有獨立編譯步驟，Node.js 直接執行儲存庫中的 ES module；`npm ci` 依鎖定檔安裝依賴。測試使用本地 fixture，不代表線上 Derpibooru 認證已成功。

<a id="部署與執行"></a>

## 部署與執行

將 `config/config.example.json` 複製到私有設定檔，再以 `MIRROR_CONFIG` 指定：

```sh
cp config/config.example.json /etc/derpibooru-mirror/config.json
MIRROR_CONFIG=/etc/derpibooru-mirror/config.json npm start
```

預設監聽 `127.0.0.1:3000`，預設上游為 `https://derpibooru.org`，TLS 驗證必須為 `true`。自訂上游仍需明確設定 `ALLOW_CUSTOM_UPSTREAM=1`，且不可關閉 TLS 驗證。`client.origin` 必須與瀏覽器使用的 Host 及協定一致。

正式環境建議讓 Node 僅監聽內網，由現有 Nginx、Caddy 或 Cloudflare Tunnel 終止 HTTPS。應用程式沒有內建 `/healthz`，可用 `curl -i http://127.0.0.1:3000/` 檢查一般代理請求。systemd 或 PM2 均可使用專用無特權帳號、受限日誌及相同的 `MIRROR_CONFIG` 環境變數執行。

<a id="隱私與-cookie-聲明"></a>

## 隱私與 Cookie 聲明

本服務端僅作為反向代理轉發層。活動工作階段中，一般上游 Cookie 會由 `SessionManager` 按工作階段、按上游 origin 暫存於服務端記憶體 CookieJar，用於維持代理工作階段；此快取不會持久化至磁碟。Anubis Cookie 主要由用戶端瀏覽器持有。

服務端不會將 Cookie、認證憑據、Token、Authorization 或其他敏感憑據持久化到磁碟；Cookie 值及敏感憑據不會寫入診斷日誌或主控台，只保留路由所需的名稱及屬性摘要。除工作階段轉發所需的記憶體快取外，本服務不作長期儲存或資料收集。具體 Cookie 及隱私規範請以上游 [Derpibooru](https://derpibooru.org) 官方條款為準；部署者仍須保護主機及基礎設施日誌。

## 授權條款

MIT，詳見 [LICENSE](LICENSE)。
