# MC Player List Checker (MC 玩家列表监控器)

这是一个基于 Node.js 的 Minecraft 服务器监控工具，旨在实时监测服务器在线玩家列表、TPS/MSPT 等状态信息，并通过 API 和 WebSocket 提供数据接口。

特别针对 **Minecraft 26.1.2 NeoForge（NeoForge 26.1.x，协议号 775）** 服务器进行了适配，同时兼容：

*   **1.21.1 / 1.21.9 / 1.21.11 NeoForge**：沿用同一套 `neoforge:register` 协商流程。
*   **1.12.2 旧版 Forge**：自动识别 FML modinfo，执行 `FML|HS` 旧版握手、mod 列表和 RegistryData 流程。
*   **现代 Forge**：保留 FML3 握手处理。

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
*   **NeoForge/Forge 支持**：内置 NeoForge 26.1.2（含 1.21.x）配置阶段网络协商、1.12.2 旧版 Forge `FML|HS` 握手，以及现代 Forge FML3 握手处理。

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
    "username": "PlayerListBot",  // 默认用户名（≤16 字符；微软登录后会自动更新为你的正版 ID）
    "logLevel": "info",       // 日志等级: silent, err, warn, info, debug, verbose, trace
    "microsoft": true,        // 是否启用微软正版验证
    "minecraftVersion": "26.1.2", // 可选：强制指定协议版本（默认 26.1.2，协议号 775）
    "modLoader": "neoforge",  // 可选：vanilla, forge, neoforge, modded；1.12.2 请设为 forge
    "legacyForgeMods": [        // 可选：1.12.2 旧版 Forge 客户端上报的 mod 列表，默认优先使用服务器 ping 返回的 modinfo
        { "modid": "forge", "version": "14.23.5.2860" }
    ],
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

NeoForge 服务器如果要求额外的 mod payload，本程序会在 `neoforgeProbe` 开启时主动探测缺失频道，并把探测进度缓存到 `.neoforge_probe_cache.json`。缓存 key 使用 `服务器地址:端口_协议版本` 的 hash（26.1/26.1.1/26.1.2 共享协议号 775，因此共用同一份缓存），支持中途停止后继续探测，也支持多个服务器自动切换，不需要把特定服务器的频道列表硬编码进 `config.json`。关闭 `neoforgeProbe` 只会停止主动学习新频道，已有缓存仍会加载使用。probe 重连会触发正版 session join，默认会对这一步做串行节流，避免快速探测时被 Mojang session server 限流。

### Minecraft 26.1.2（NeoForge 26.1.x）适配说明

26.1 的 NeoForge 协商协议本身没有变化（通道名、payload 字段顺序、`ConnectionProtocol` 序号 `play=1`/`configuration=4` 全部一致），但有三个上游行为必须额外处理，本分支已内置：

1. **未声明的频道不许下发**：26.1 的 `NetworkRegistry.checkPacket()` 只允许服务端下发「客户端已声明」的频道。NeoForge 会在 configuration 阶段无条件下发 `neoforge:extensible_enum_data`，并在进入世界后立即下发 `neoforge:recipe_content`，因此客户端必须通过 `minecraft:register` 提前声明这两个频道，否则会被 `multiplayer.disconnect.configuration_error` / `multiplayer.disconnect.invalid_player_data` 断开。本程序在 configuration 阶段一开始（早于 `pong`）就声明内建频道集合。
2. **登录必须带 `playerUUID`**：26.1 的 `login_start` 需要 UUID，而 `minecraft-protocol` 只在 offline/microsoft 认证分支下准备 `client.uuid`（Mojang 账号认证已下线），因此非正版登录统一走 `offline` 分支。
3. **命令树校验不兼容**：`minecraft-protocol@1.68.0` 的 `declare_commands` 校验（`impossibleCommandTree`）会对 26.1 的命令树误判并主动断线。本程序不使用命令树（只读玩家列表/TPS），已禁用该校验并保留诊断日志。
4. **玩家名必须 ≤16 字符**：真实服务端的 login 首包（`ServerboundHelloPacket`，在 NeoForge 日志里显示为 `serverbound/minecraft:hello`）用 `readUtf(16)` 读取名字，超长会被服务端判为解码失败（客户端只显示"网络协议错误"）。`minecraft-protocol` 自带的服务端不做这个校验，因此本地自测发现不了；本程序会对超长用户名自动截断并告警。

`neoforgeProbe` 的候选声明、probe 缓存格式与 1.21.x 完全共用；已连接的 1.21.x 服务器缓存不会被 26.1.2 的缓存覆盖（key 不同）。

连接 1.12.2 Forge 服务器时，程序会在登录后通过 `REGISTER` 注册旧版 Forge 频道，并按 `FML|HS` 的 ServerHello → ClientHello/ModList → RegistryData → HandshakeAck 流程完成握手。默认客户端 mod 列表优先从服务器 ping 返回的 `modinfo.modList` 自动生成；如果你的服务器 ping 未返回完整 modinfo，可显式配置 `legacyForgeMods` 或 `forgeMods`。

### NeoForge Server 采集模式

如果你有真实 NeoForge 客户端，可以让客户端连接到本程序一次，直接采集客户端发送的 `neoforge:register` 全量 payload 声明并写入同一个 probe 缓存：

```bash
npm run server
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

**Q: 连接 1.12.2 Forge 服务器时能登录但玩家列表为空或握手卡住？**
A: 请确认 `minecraftVersion` 为 `1.12.2`、`modLoader` 为 `forge`。如果服务器没有在 ping 响应中返回 modinfo，可在 `config.json` 中显式配置 `legacyForgeMods`，内容应至少包含服务器要求客户端具备的 Forge/FML 版本。

**Q: 连接 26.1.2 NeoForge 服务器时被踢，提示 `configuration_error` 或 `invalid_player_data`？**
A: 说明客户端没有按 26.1 的要求声明 `neoforge:extensible_enum_data` / `neoforge:recipe_content`（服务端 `checkPacket` 只允许下发已声明的频道）。本分支已内置声明；如果你修改过 `NEOFORGE_261_REQUIRED_CLIENTBOUND_CHANNELS`，请确认两个频道都在。

**Q: 客户端报"网络协议错误"，服务端日志显示 `Failed to decode packet 'serverbound/minecraft:hello'`？**
A: `minecraft:hello` 就是 login 首包（`ServerboundHelloPacket`）。常见原因是 **用户名超过 16 字符**——真实服务端用 `readUtf(16)` 读取玩家名，超长直接抛解码异常（本程序会自动截断并告警）。也请确认 `minecraftVersion`/`modLoader` 与实际服务端一致。

**Q: 被踢并提示 `multiplayer.disconnect.unverified_username`（未验证的用户名）？**
A: 目标服务器开启了正版验证（online-mode）。请在 `config.json` 中设置 `"microsoft": true`，首次运行按控制台提示完成一次微软设备码登录，凭据会缓存到 `./.minecraft_auth`，之后可自动登录。

**Q: 26.1.2 服务器的 ping 结果里 `playersOnline` 一直是 0？**
A: `playersOnline` 来自服务器状态响应（`status`），而玩家明细来自游戏内 `player_info`。如果服务器在空闲时会暂停（`Server empty for 60 seconds, pausing`），状态响应可能暂时只反映机器人自己或为空，以 `/players` 返回的 `players` 数组为准。

**Q: 控制台出现 `PartialReadError: Unexpected buffer end` 报错？**
A: 这是由于 `minecraft-protocol` 库在解析某些新的 1.20.2+、NeoForge 或特定 Forge 数据包时出现的警告。只要显示已登录并且能正常接收玩家信息，通常不影响功能，可以忽略。

**Q: 日志出现 `Received command tree (... nodes, upstream tree validation disabled)`？**
A: 这是有意为之：26.1 的命令树会让 `minecraft-protocol` 的校验误判并断线，本程序不使用命令树，因此禁用了该校验，这行日志仅用于确认命令树已被解析。

**Q: 无法连接 MongoDB？**
A: 程序会提示 `Continuing without MongoDB...`。由于项目目前已降级 MongoDB 驱动以兼容旧版本（3.6+），请检查连接地址和数据库状态。

## ℹ️ 说明

本项目部分核心逻辑与代码由 Gemini 3 Flash 辅助编写完成。
