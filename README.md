# MC Player List Checker (MC 玩家列表监控器)

这是一个基于 Node.js 的 Minecraft 服务器监控工具，旨在实时监测服务器在线玩家列表、TPS/MSPT 等状态信息，并通过 API 和 WebSocket 提供数据接口。

特别针对 **Minecraft 1.21.1 NeoForge** 服务器进行了适配，同时保留现代 Forge 的 FML3 握手处理。

## ✨ 主要功能

*   **实时监控**：获取在线玩家列表、延迟 (Ping)、服务器 TPS 和 MSPT（需服务器支持 PlayerList Header/Footer）。
*   **数据持久化**：支持连接 **MongoDB**，记录玩家进服/退服日志以及服务器历史状态（TPS 波动等）。
*   **微软正版登录**：支持通过 Microsoft 账号登录，并自动识别实际游戏用户名。
*   **自动凭据缓存**：支持通过 `profilesFolder` 自动在本地 `.minecraft_auth` 目录缓存登录凭据，实现重启后自动登录。
*   **API & WebSocket**：
    *   提供 HTTP 接口查询当前状态。
    *   提供 WebSocket 接口实时推送玩家变动和状态更新。
    *   支持 WebSocket 双向通信：发送任意消息即可触发立即刷新。
*   **智能过滤**：自动过滤机器人自身的进退服记录，不做无效统计。
*   **NeoForge/Forge 支持**：内置 NeoForge 1.21.1 配置阶段网络协商，以及 Forge FML3 握手处理。

## 🛠️ 环境要求

*   [Node.js](https://nodejs.org/) (建议 v18+)
*   [MongoDB](https://www.mongodb.com/) (可选，用于数据记录)

## 📦 安装/运行

1.  克隆仓库：
    ```bash
    git clone https://github.com/yourusername/mcplayerlistchecker.git
    cd mcplayerlistchecker
    ```

2.  安装依赖：
    ```bash
    npm install
    ```

3.  启动运行：
    ```bash
    # 开发模式
    npx ts-node src/index.ts
    # 编译并运行
    npm start
    ```

## ⚙️ 配置

第一次运行程序会自动读取默认配置。你可以创建或修改根目录下的 `config.json` 文件：

```json
{
    "host": "localhost",      // 目标服务器 IP
    "port": 25565,            // 目标服务器端口
    "username": "PlayerListChecker",  // 默认用户名 (微软登录后会自动更新)
    "logLevel": "info",       // 日志等级: silent, err, warn, info, debug, verbose, trace
    "microsoft": true,        // 是否启用微软正版验证
    "minecraftVersion": "1.21.1", // 可选：强制指定协议版本
    "modLoader": "neoforge",  // 可选：vanilla, forge, neoforge, modded
    "neoforgeProbe": true,    // 可选：主动探测 NeoForge 必需 payload
    "neoforgeProbeRetryDelayMs": 1000, // 可选：主动探测失败后的快速重试间隔
    "minecraftSessionJoinThrottle": true, // 可选：probe 时节流正版 session join
    "minecraftSessionJoinMinIntervalMs": 3000, // 可选：session join 最小间隔
    "minecraftSessionJoinRateLimitBackoffMs": 15000, // 可选：session join 限流后的退避时间
    "neoforgeProbeCacheFile": ".neoforge_probe_cache.json", // 可选：主动探测缓存路径
    "mode": "client",        // 可选：client 或 server；server 用于真实客户端采集配置
    "serverModeHost": "0.0.0.0", // 可选：server 模式监听地址
    "serverModePort": 25566, // 可选：server 模式监听端口
    "apiPort": 3000,          // API 服务器端口
    "mongoUri": "mongodb://localhost:27017", // MongoDB 连接地址
    "mongoDb": "mc_checker"   // 数据库名称
}
```

NeoForge 1.21.1 服务器如果要求额外的 mod payload，本程序会在 `neoforgeProbe` 开启时主动探测缺失频道，并把探测进度缓存到 `.neoforge_probe_cache.json`。缓存 key 使用 `服务器地址:端口_协议版本` 的 hash，支持中途停止后继续探测，也支持多个服务器自动切换，不需要把特定服务器的频道列表硬编码进 `config.json`。关闭 `neoforgeProbe` 只会停止主动学习新频道，已有缓存仍会加载使用。probe 重连会触发正版 session join，默认会对这一步做串行节流，避免快速探测时被 Mojang session server 限流。

### NeoForge Server 采集模式

如果你有真实 NeoForge 客户端，可以让客户端连接到本程序一次，直接采集客户端发送的 `neoforge:register` 全量 payload 声明并写入同一个 probe 缓存：

```bash
npx ts-node src/index.ts --server-mode
```

默认监听 `0.0.0.0:25566`。客户端进入服务器列表连接 `127.0.0.1:25566`，采集完成后程序会写入 `.neoforge_probe_cache.json`，随后继续完成 configuration 流程；之后正常 client 模式会按目标服务器 `host:port_协议版本` 的 hash 读取这些声明。

### 启动参数 (CLI)

命令行参数优先级高于配置文件：
```bash
npx ts-node src/index.ts [host] [port] [username] [loglevel] [--microsoft] [--config <path>] [--server-mode]
```

## 🚀 关于登录 (Microsoft Auth)

第一次使用微软登录时，控制台会输出一个验证码及验证链接（Microsoft Device Code）。请在浏览器中打开链接完成验证。

验证成功后，登录凭据会自动加密保存在 `.minecraft_auth/` 文件夹下。下次启动时，程序会自动从该文件夹读取凭据，无需再次进行人工验证。

### 🐳 Docker 运行建议

如果你在 Docker 中运行，请务必挂载该目录以保持登录状态，并注意 Docker 环境与宿主机 MongoDB 的连接（Linux 通常使用主机的 `host.docker.internal`）：

```bash
touch .neoforge_probe_cache.json
docker run -d \
  --name mc-checker \
  -p 3000:3000 \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/.minecraft_auth:/app/.minecraft_auth \
  -v $(pwd)/.neoforge_probe_cache.json:/app/.neoforge_probe_cache.json \
  mc-checker
```

## 🔌 API 接口

本项目在默认的 3000 端口提供 API 服务。

详细文档请参阅 [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)。

*   **HTTP GET** `/players`: 获取当前玩家和服务器状态。
*   **HTTP GET** `/status`: 仅获取服务器状态。
*   **WebSocket**: 连接 `ws://localhost:3000` 获取实时推送。

## ⚠️ 常见问题

**Q: 控制台出现 `PartialReadError: Unexpected buffer end` 报错？**
A: 这是由于 `minecraft-protocol` 库在解析某些新的 1.20.2+、NeoForge 或特定 Forge 数据包时出现的警告。只要显示已登录并且能正常接收玩家信息，通常不影响功能，可以忽略。

**Q: 无法连接 MongoDB？**
A: 程序会提示 `Continuing without MongoDB...`。由于项目目前已降级 MongoDB 驱动以兼容旧版本（3.6+），请检查连接地址和数据库状态。

## ℹ️ 说明

本项目部分核心逻辑与代码由 Gemini 3 Flash 辅助编写完成。
