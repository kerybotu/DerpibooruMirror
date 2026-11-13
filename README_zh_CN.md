# DerpibooruMirror

[English](README.md) | [简体中文](README_zh_CN.md) | [繁體中文](README_zh_TW.md)

**目录：** [项目介绍](#项目介绍) · [架构与原理](#架构与原理) · [编译与测试](#编译与测试) · [部署与运行](#部署与运行) · [隐私与 Cookie 声明](#隐私与-cookie-声明)

<a id="项目介绍"></a>

DerpibooruMirror 是专用于 [`https://derpibooru.org`](https://derpibooru.org) 的固定源站反向代理。发布版本默认已预设该上游，下载后无需修改上游地址即可运行。代理不接受浏览器提供的任意上游 URL，适合放在私人访问边界之后，不应作为开放公共转发器。

它支持流式响应、媒体 `Range`/`206`/`416`、WebSocket，以及有大小限制的 HTML/CSS/JSON URL 重写；Anubis 适配器按精确版本选择，未知版本保持 fail-closed。

<a id="架构与原理"></a>

## 架构与原理

浏览器连接 `client.origin`，`ClientGateway` 校验固定路由，`ProxyEngine` 将请求发送至固定的 Derpibooru origin，`UpstreamGateway` 再把响应流返回浏览器。二进制和流式内容不做全文缓存，URL 重写只处理已知上游地址。

`SessionManager` 为每个镜像会话和上游 origin 建立独立的内存 `tough-cookie CookieJar`。普通上游 Cookie 只在活动会话期间暂存于该内存容器，以便后续请求维持会话，绝不写入磁盘。Anubis Cookie 主要由客户端浏览器持有，代理只向匹配的会话转发已识别 Cookie，并保留名称和属性摘要用于路由与诊断。

诊断只包含 request/flow ID、状态码、Content-Type、Cookie 名称和属性摘要。Cookie 值、Authorization、Token、PoW 参数和敏感查询参数在输出前均被脱敏。

<a id="编译与测试"></a>

## 编译与测试

要求 Node.js 22 或更高版本，并能访问 npm registry 与 `derpibooru.org`。

```sh
git clone https://github.com/kerybotu/DerpibooruMirror.git
cd DerpibooruMirror
npm ci
npm test
npm run test:coverage
git diff --check
```

项目没有单独编译步骤，Node.js 直接运行仓库中的 ES module；`npm ci` 按锁定文件安装依赖。测试使用本地 fixture，不代表线上 Derpibooru 认证已经成功。

<a id="部署与运行"></a>

## 部署与运行

复制 `config/config.example.json` 到私有配置文件，通过 `MIRROR_CONFIG` 指定：

```sh
cp config/config.example.json /etc/derpibooru-mirror/config.json
MIRROR_CONFIG=/etc/derpibooru-mirror/config.json npm start
```

默认监听 `127.0.0.1:3000`，默认上游为 `https://derpibooru.org`，TLS 校验必须为 `true`。自定义上游还需要显式设置 `ALLOW_CUSTOM_UPSTREAM=1`，且不能关闭 TLS 校验。`client.origin` 必须与浏览器使用的 Host 和协议一致。

生产环境建议让 Node 仅监听内网，由现有 Nginx、Caddy 或 Cloudflare Tunnel 终止 HTTPS。应用没有内置 `/healthz`，可用 `curl -i http://127.0.0.1:3000/` 检查普通代理请求。systemd 或 PM2 均可使用专用无特权用户、受限日志和相同的 `MIRROR_CONFIG` 环境变量运行。

<a id="隐私与-cookie-声明"></a>

## 隐私与 Cookie 声明

本服务端仅作为反向代理转发层。活动会话中，普通上游 Cookie 会由 `SessionManager` 按会话、按上游 origin 暂存于服务端内存 CookieJar，用于维持代理会话；该缓存不会持久化到磁盘。Anubis Cookie 主要由客户端浏览器持有。

服务端不对 Cookie、认证凭据、Token、Authorization 或其他敏感凭据进行磁盘持久化；Cookie 值和敏感凭据不会写入诊断日志或控制台，只保留路由所需的名称和属性摘要。除会话期转发所需的内存缓存外，本服务不作长期存储或数据收集。具体 Cookie 和隐私规范请以上游 [Derpibooru](https://derpibooru.org) 官方条款为准；部署者仍须保护主机和基础设施日志。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
