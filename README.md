# MC Player List Checker (MC 玩家列表监控器)

这是一个基于 Node.js 的 Minecraft 服务器监控工具，旨在实时监测服务器在线玩家列表、TPS/MSPT 等状态信息，并通过 API 和 WebSocket 提供数据接口。

特别针对 **Minecraft 1.20.1 Forge** 服务器进行了适配（支持 FML3 握手协议）。

## ✨ 主要功能

*   **实时监控**：获取在线玩家列表、延迟 (Ping)、服务器 TPS 和 MSPT（需服务器支持 PlayerList Header/Footer）。
*   **数据持久化**：支持连接 **MongoDB**，记录玩家进服/退服日志以及服务器历史状态（TPS 波动等）。
*   **微软正版登录**：支持通过 Microsoft 账号登录，并自动识别实际游戏用户名。
*   **安全凭据存储**：使用 AES-256 加密在本地缓存登录凭据，并在启动时要求输入解密密码（Passphrase），避免明文存储 Token。
*   **API & WebSocket**：
    *   提供 HTTP 接口查询当前状态。
    *   提供 WebSocket 接口实时推送玩家变动和状态更新。
    *   支持 WebSocket 双向通信：发送任意消息即可触发立即刷新。
*   **智能过滤**：自动过滤机器人自身的进退服记录，不做无效统计。
*   **Forge 支持**：内置对 Forge 1.20.1+ 网络协议的特殊处理（Handshake Tagging）。

## 🛠️ 环境要求

*   [Node.js](https://nodejs.org/) (建议 v18+)
*   [MongoDB](https://www.mongodb.com/) (可选，用于数据记录)

## 📦 安装

1.  克隆仓库：
    ```bash
    git clone https://github.com/yourusername/mcplayerlistchecker.git
    cd mcplayerlistchecker
    ```

2.  安装依赖：
    ```bash
    npm install
    # 或者
    npm i
    ```

## ⚙️ 配置

第一次运行程序会自动读取默认配置。你可以创建或修改根目录下的 `config.json` 文件：

```json
{
    "host": "localhost",      // 目标服务器 IP
    "port": 25565,            // 目标服务器端口
    "username": "PlayerListChecker",  // 默认用户名 (微软登录后会自动更新)
    "logLevel": "info",       // 日志等级: silent, err, warn, info, debug, verbose
    "microsoft": true,        // 是否启用微软正版验证
    "apiPort": 3000,          // API 服务器端口
    "mongoUri": "mongodb://localhost:27017", // MongoDB 连接地址
    "mongoDb": "mc_checker"   // 数据库名称
}
```

### 启动参数 (CLI)

命令行参数优先级高于配置文件：
```bash
npx ts-node src/index.ts [host] [port] [username] [loglevel] [--microsoft] [--config <path>]
```

例如：
```bash
npx ts-node src/index.ts play.example.com 25565 PlayerListChecker info
```

## 🚀 运行

### 开发模式运行
```bash
npx ts-node-dev src/index.ts
```

### 正常启动
```bash
npm start
```

第一次使用微软登录时，控制台会提示你会打开浏览器进行验证。验证通过后，程序会要求你一次性输入一个 **Passphrase**（密码口令）来加密保存你的 Token。

下次启动时，只需输入之前的 Passphrase 即可自动登录，无需再次扫码。

## 🔌 API 接口

本项目在默认的 3000 端口提供 API 服务。

详细文档请参阅 [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)。

*   **HTTP GET** `/players`: 获取当前玩家和服务器状态。
*   **HTTP GET** `/status`: 仅获取服务器状态。
*   **WebSocket**: 连接 `ws://localhost:3000` 获取实时推送。

## ⚠️ 常见问题

**Q: 控制台出现 `PartialReadError: Unexpected buffer end` 报错？**
A: 这是由于 `minecraft-protocol` 库在解析某些新的 1.20.2+ 或特定 Forge 数据包（如已读消息确认位图）时可能出现的警告。只要程序显示 `Logged in to Forge server!` 并且能正常接收玩家信息，该错误通常**不影响**核心监控功能，可以忽略。

**Q: 无法连接 MongoDB？**
A: 程序会提示 `Continuing without MongoDB...` 并继续运行，只是不会记录日志。请检查本地 MongoDB 服务是否启动。

## ℹ️ 说明

本项目部分核心逻辑与代码由 Gemini 3 Flash 辅助编写完成。
