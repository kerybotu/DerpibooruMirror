# DerpibooruMirror

[English](README.md) | [简体中文](README_zh_CN.md) | [繁體中文](README_zh_TW.md)

**目录：** [项目介绍](#项目介绍) · [架构与原理](#架构与原理) · [编译与测试](#编译与测试) · [部署与运行](#部署与运行) · [隐私与 Cookie 声明](#隐私与-cookie-声明)

<a id="项目介绍"></a>

DerpibooruMirror 是专用于 [`https://derpibooru.org`](https://derpibooru.org) 的固定源站反向代理。项目默认使用该上游，安装依赖后即可启动，无需修改上游地址。浏览器请求不能指定任意上游 URL。建议仅供私人使用，或在入口设置访问控制，避免成为开放代理。

它支持流式响应、媒体 `Range`/`206`/`416`、WebSocket，以及有大小限制的 HTML/CSS/JSON URL 重写；Anubis 适配器按精确版本选择，未知版本不会启用专用回跳映射（fail-closed），也不会自动切换适配器。

<a id="架构与原理"></a>

## 架构与原理

浏览器连接 `client.origin`。服务端校验 Host 请求头后，由 `ClientGateway` 创建请求上下文，再将固定路由交给 `UpstreamGateway`。后者调用 `ProxyEngine`，完成上游请求转发和响应传输。二进制响应采用流式传输，URL 重写仅处理已知上游地址，并限制可重写的响应大小。

`SessionManager` 为每个代理会话和上游源站（origin）建立独立的内存 CookieJar（由 `tough-cookie` 提供）。普通上游 Cookie 只在会话期间暂存于该内存容器，以便后续请求维持会话，绝不写入磁盘。Anubis Cookie 主要由客户端浏览器持有，代理只向匹配的会话转发已识别 Cookie，并保留名称和属性摘要用于路由与诊断。

诊断日志组件支持记录请求 ID、流程 ID、状态码、Content-Type，以及 Cookie 名称和属性摘要；它不会输出凭据请求头，并会遮蔽已知的敏感查询字段。默认的 `npm start` 入口未接入逐请求诊断日志。自行接入日志时，应使用项目提供的脱敏工具，避免直接输出请求头、请求体或请求上下文。

<a id="编译与测试"></a>

## 编译与测试

需要 Git、Node.js 22 或更高版本，以及 npm。安装依赖时需要访问 npm 软件包仓库；运行代理时需要访问 `derpibooru.org`。

```sh
git clone https://github.com/kerybotu/DerpibooruMirror.git
cd DerpibooruMirror
npm ci
npm test
npm run test:coverage
git diff --check
```

项目没有单独编译步骤，Node.js 直接运行仓库中的 ES 模块；`npm ci` 依据锁文件安装依赖。测试使用本地测试服务与数据，不代表线上 Derpibooru 认证已经成功。

<a id="部署与运行"></a>

## 部署与运行

复制 `config/config.example.json` 到私有配置文件，通过 `MIRROR_CONFIG` 指定：

```sh
cp config/config.example.json config.local.json
MIRROR_CONFIG="$PWD/config.local.json" npm start
```

启动前请编辑 `config.local.json`，并将其排除在版本控制之外。Windows PowerShell 用户可先执行 `$env:MIRROR_CONFIG = (Resolve-Path ./config.local.json).Path`，再运行 `npm start`。监听和上游设置从 JSON 读取，不支持用 `SERVER_HOST` 或 `UPSTREAM_ORIGIN` 环境变量覆盖。

默认监听 `127.0.0.1:3000`，默认上游为 `https://derpibooru.org`，TLS 校验必须为 `true`。自定义上游还需要显式设置 `ALLOW_CUSTOM_UPSTREAM=1`，且不能关闭 TLS 校验。`client.origin` 必须与浏览器使用的 Host 和协议一致。

生产环境建议让 Node 仅监听本机回环地址，由现有 Nginx、Caddy 或 Cloudflare Tunnel 终止 HTTPS。应用没有内置 `/healthz`。默认配置可用 `curl -I http://127.0.0.1:3000/` 检查连通性。如果 `client.origin` 改为 `https://mirror.example.com`，检查命令应改为 `curl -I -H "Host: mirror.example.com" http://127.0.0.1:3000/`；Host 不匹配会返回 421。收到 HTTP 响应只说明链路可达，还需核对状态码并通过浏览器验证认证流程。systemd 或 PM2 均可使用专用无特权用户、受限日志和相同的 `MIRROR_CONFIG` 环境变量运行。

<a id="隐私与-cookie-声明"></a>

## 隐私与 Cookie 声明

本服务端仅作为反向代理转发层。会话期间，普通上游 Cookie 会由 `SessionManager` 按会话、按上游源站暂存于服务端内存 CookieJar，用于维持代理会话；该缓存不会持久化到磁盘。Anubis Cookie 主要由客户端浏览器持有。

服务端不对 Cookie、认证凭据、Token、Authorization 或其他敏感凭据进行磁盘持久化；Cookie 值和敏感凭据不会写入诊断日志或控制台，只保留路由所需的名称和属性摘要。除会话期转发所需的内存缓存外，本服务不作长期存储或数据收集。上游处理的数据适用 [Derpibooru](https://derpibooru.org) 官方 Cookie 与隐私政策。部署者仍须对经过代理的数据和自身主机、基础设施日志负责；上游政策不能替代部署者应作出的披露。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
