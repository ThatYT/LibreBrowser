# LibreBrowser

使用 Go、SQLite 和官方 LinuxServer Chromium 镜像的轻量多用户浏览器服务。[English](README.md)

**已部署至 [browser.home.libremedicine.org](https://browser.home.libremedicine.org)。** LibreBrowser 和 Chromium 均运行在家庭服务器上；VPS 负责 HTTPS 和私有 FRP 转发。已有账户及浏览器配置保留。此前已在本地验证双用户 Chromium 视频流、配置隔离、出口限制、会话撤销和五分钟空闲停机。详细结果及未完成的公网部署检查见 [验证记录](docs/VERIFICATION.md)。

登录页仅含用户名、密码、登录按钮及 EN / 中文切换。登录后自动启动个人浏览器，顶部始终显示“账户”和“退出登录”，启动或重新连接期间也可操作。不提供公开注册。管理员可从顶部“用户”链接进入账户管理页。访问 `/account` 可修改密码（须验证当前密码）或退出；管理员也可直接访问 `/admin/users`，添加用户、设置初始密码、重置其他用户的密码及确认删除账户。重置密码会退出该用户的所有登录，删除账户会保留其已保存的浏览器配置。普通用户看不到管理链接，服务端也会检查每个管理请求的管理员权限。

## 本地运行

需要 Go 1.26+。不需要 Node.js、Redis 或外部数据库。

```sh
go test ./...
go vet ./...
go build -o bin/librebrowser ./cmd/librebrowser
./bin/librebrowser admin init --username thatyt
LOCAL_DEV=true PUBLIC_ORIGIN=http://localhost:8090 ./bin/librebrowser serve
```

访问 `http://localhost:8090`。此命令运行真实认证服务；完整浏览器功能需要 Docker broker。缺少 broker 时登录后显示重新连接界面，不会伪装浏览器已启动。本地开发模式只允许回环 HTTP 监听；正式配置要求 HTTPS、可信反向代理及 Secure Cookie。

## Docker 部署

需要 Docker Engine 28+、Compose v2 和 Docker 操作权限。先阅读 [部署说明](docs/DEPLOYMENT.md)。

```sh
./scripts/install.sh
docker compose run --rm --no-deps app admin init --username thatyt
# 配置 .env 中的域名、真实代理来源 CIDR、服务器公网地址拒绝列表。
docker compose up -d
```

仅绑定 `127.0.0.1:8090`。可使用 `deploy/Caddyfile.local` 和 `PUBLIC_ORIGIN=https://localhost:9443` 进行独立本地 TLS 测试。不要更改现有 Caddy、FRP、SSH 或防火墙。安装脚本只构建及拉取镜像。

如需使用宿主机已有的 v2rayA，请阅读 [v2rayA 接入说明](docs/DEPLOYMENT.md#existing-host-v2raya)。容器不会继承宿主机系统代理；可选的 Unix socket 转接保留出口限制，无须开放 v2rayA 的局域网端口。

管理员密码通过本地终端隐藏输入，不使用命令行参数、环境变量或硬编码密码。紧急恢复：

```sh
docker compose exec app librebrowser admin reset-password --username thatyt
```

LibreBrowser 的 `thatyt` 与 Ubuntu 同名账户无关。任何操作都不会修改 Linux 密码。已有账户后禁止重复初始化；最后一位启用的管理员不能被删除、禁用或降级。重置或修改密码会撤销全部相关登录，并在约一秒内关闭现有浏览器连接。

## 会话、隔离与维护

每个用户拥有独立浏览器容器、持久化配置卷、隔离网络及仅允许公网 HTTP/HTTPS 的出口代理。网页服务不能访问 Docker socket；只有通过 Unix socket 提供固定操作的 broker 拥有 Docker 权限。浏览器不挂载 Docker socket，不公开流媒体端口，禁用终端、sudo、分享链接及命令接口。容器使用内存、CPU 和进程数量限制，重启主机后不会自动启动浏览器。

同一用户可从多个设备重连个人浏览器，当前上游会切换主连接，不启用同账户同时协作控制；最后一个流连接断开五分钟后自动停止。短暂断线不会立即退出登录。服务恢复时停止遗留容器并保留配置。删除账户会撤销会话、停止浏览器，但配置卷保留，须由运维人员明确清理。

管理员接口及示例见 [API 文档](docs/API.md)。运行 `./scripts/update.sh` 更新本项目并备份账户数据库；浏览器配置卷需要单独离线备份。升级 Chromium 时须先测试并固定镜像摘要，再按部署文档重建已有浏览器容器。

上游镜像以 `--no-sandbox` 启动 Chromium，主要依赖容器隔离。容器共享宿主机内核，不能视为面向恶意租户的虚拟机隔离。必须将宿主机、VPS 及管理端点的公网 IP 加入 `EGRESS_DENY_CIDRS`，并完成真实网络测试后才可评估公网发布。当前限制仅允许 80/443 端口，部分依赖 UDP/WebRTC 或特殊端口的网站可能无法使用。无遥测、广告或外部前端资源。

已在用户批准后将宿主机 IPv4 转发运行值设为 `1`，未修改持久化 sysctl 文件。现有网络组件可能重置此值，部署前须协调。测试中的 Chromium 在信号停机后可能显示恢复提示，已验证浏览历史及配置卷保留；不能将普通会话 Cookie 视为永久 Cookie。
