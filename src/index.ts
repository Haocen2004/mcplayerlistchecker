import * as fs from 'fs';
import * as path from 'path';
import { initDb } from './db';
import { MCClient, LogLevel } from './mcClient';
import { CompressionType } from './compression';
import { startApiServer } from './api';
import { startNeoForgeConfigServer } from './neoforgeConfigServer';
import { captureController } from './captureApi';

const DEFAULT_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

// 把 stdout/stderr 同时写入文件（默认关闭）。
// 容器里 `docker logs` 依赖 log driver，容器重建后历史日志就没了；
// 开启 logFile 后可以把日志挂载到宿主机持久保存，便于排查断线重连这类需要长期观察的问题。
function setupLogFile(logFile: string, maxBytes: number) {
    const resolved = path.resolve(logFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    // 简单的单份轮转：超过上限就把当前文件改名成 .1
    try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).size >= maxBytes) {
            fs.renameSync(resolved, `${resolved}.1`);
        }
    } catch (e) {
        console.error(`[Log] 日志轮转失败：${(e as Error).message}`);
    }

    const stream = fs.createWriteStream(resolved, { flags: 'a' });
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    const tee = (original: typeof process.stdout.write) => (chunk: any, encoding?: any, callback?: any) => {
        try {
            stream.write(chunk);
        } catch {
            // 写文件失败不应影响正常输出
        }
        return original(chunk, encoding, callback);
    };

    process.stdout.write = tee(originalStdoutWrite) as any;
    process.stderr.write = tee(originalStderrWrite) as any;
    console.log(`[Log] 日志同时写入 ${resolved}（单文件上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
}

async function bootstrap() {
    // 1. Determine config path
    let configPath = path.join(process.cwd(), 'config.json');
    const configIdx = process.argv.indexOf('--config');
    if (configIdx !== -1 && process.argv[configIdx + 1]) {
        configPath = path.resolve(process.argv[configIdx + 1]);
    }

    // 2. Load config
    let config: any = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log(`[Config] Loaded from ${configPath}`);
        } catch (e) {
            console.error(`[Config] Failed to parse ${configPath}: ${e}`);
        }
    }

    // 3. Merge with CLI Args
    if (config.logFile) {
        const maxBytes = Number(config.logFileMaxBytes);
        setupLogFile(String(config.logFile), Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_LOG_FILE_MAX_BYTES);
    }

    const host = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : (config.host || 'localhost');
    const port = (process.argv[3] && !isNaN(parseInt(process.argv[3]))) ? parseInt(process.argv[3]) : (config.port || 25565);
    const username = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : (config.username || 'PlayerListBot');
    const logLevelStr = (process.argv[5] && !process.argv[5].startsWith('--') ? process.argv[5] : (config.logLevel || 'info')).toUpperCase();
    const authType: 'microsoft' | 'mojang' = (process.argv.includes('--microsoft') || config.microsoft) ? 'microsoft' : 'mojang';
    const apiPort = config.apiPort || 3000;
    const mongoUri = config.mongoUri || 'mongodb://localhost:27017';
    const mongoDb = config.mongoDb || 'mc_checker';
    const compressionType: CompressionType = (config.compression === 'zstd') ? 'zstd' : 'zlib';
    const serverMode = process.argv.includes('--server-mode') || config.mode === 'server' || config.serverMode === true;

    const logLevel = (LogLevel as any)[logLevelStr] ?? LogLevel.INFO;

    if (serverMode) {
        startNeoForgeConfigServer({
            listenHost: config.serverModeHost || config.captureHost || '0.0.0.0',
            listenPort: Number(config.serverModePort || config.capturePort || 25566),
            targetHost: host,
            targetPort: port,
            minecraftVersion: config.minecraftVersion || '26.1.2',
            cacheFile: config.neoforgeProbeCacheFile,
            captureTimeoutMs: config.serverModeCaptureTimeoutMs,
            continueConfigurationAfterCapture: config.serverModeContinueAfterCapture === true,
            forceOverwrite: config.serverModeCaptureForce === true
        });
        return;
    }

    console.log('\n--- MC Player List Checker ---');

    // Initialize DB
    try {
        await initDb(mongoUri, mongoDb);
    } catch (e) {
        console.warn('[DB] Continuing without MongoDB...');
    }

    const mcClient = new MCClient(host, port, username, logLevel, authType, compressionType);
    if (config.minecraftVersion) mcClient.clientOptions.version = config.minecraftVersion;
    if (config.modLoader) mcClient.clientOptions.modLoader = config.modLoader;
    if (config.neoforgeProbe !== undefined) mcClient.clientOptions.neoforgeProbe = config.neoforgeProbe;
    if (config.neoforgeProbeMaxChannels !== undefined) mcClient.clientOptions.neoforgeProbeMaxChannels = config.neoforgeProbeMaxChannels;
    if (config.neoforgeProbeRetryDelayMs !== undefined) mcClient.clientOptions.neoforgeProbeRetryDelayMs = config.neoforgeProbeRetryDelayMs;
    if (config.neoforgeProbeCacheFile) mcClient.clientOptions.neoforgeProbeCacheFile = config.neoforgeProbeCacheFile;
    if (config.minecraftSessionJoinThrottle !== undefined) mcClient.clientOptions.minecraftSessionJoinThrottle = config.minecraftSessionJoinThrottle;
    if (config.minecraftSessionJoinMinIntervalMs !== undefined) mcClient.clientOptions.minecraftSessionJoinMinIntervalMs = config.minecraftSessionJoinMinIntervalMs;
    if (config.minecraftSessionJoinRateLimitBackoffMs !== undefined) mcClient.clientOptions.minecraftSessionJoinRateLimitBackoffMs = config.minecraftSessionJoinRateLimitBackoffMs;
    if (config.neoforgeChannels) mcClient.clientOptions.neoforgeChannels = config.neoforgeChannels;
    if (config.legacyForgeMods) mcClient.clientOptions.legacyForgeMods = config.legacyForgeMods;
    if (config.forgeMods) mcClient.clientOptions.forgeMods = config.forgeMods;
    if (config.hideErrors !== undefined) mcClient.clientOptions.hideErrors = config.hideErrors;
    if (config.tpsFallbackEnabled !== undefined) mcClient.clientOptions.tpsFallbackEnabled = config.tpsFallbackEnabled;
    if (config.tpsFallbackIdleMs !== undefined) mcClient.clientOptions.tpsFallbackIdleMs = config.tpsFallbackIdleMs;
    if (config.tpsFallbackCheckIntervalMs !== undefined) mcClient.clientOptions.tpsFallbackCheckIntervalMs = config.tpsFallbackCheckIntervalMs;
    if (config.tpsFallbackCooldownMs !== undefined) mcClient.clientOptions.tpsFallbackCooldownMs = config.tpsFallbackCooldownMs;
    if (config.tpsFallbackResponseWindowMs !== undefined) mcClient.clientOptions.tpsFallbackResponseWindowMs = config.tpsFallbackResponseWindowMs;
    if (config.tpsFallbackCommand !== undefined) mcClient.clientOptions.tpsFallbackCommand = config.tpsFallbackCommand;
    if (config.chatSigning !== undefined) mcClient.clientOptions.chatSigning = config.chatSigning;
    if (config.chatSigningTimeoutMs !== undefined) mcClient.clientOptions.chatSigningTimeoutMs = config.chatSigningTimeoutMs;
    if (config.tpsCommandFailureBackoffMs !== undefined) mcClient.clientOptions.tpsCommandFailureBackoffMs = config.tpsCommandFailureBackoffMs;
    if (config.tpsCommandMaxFailures !== undefined) mcClient.clientOptions.tpsCommandMaxFailures = config.tpsCommandMaxFailures;

    // 仅采集接口：模组包更新后可用 POST /capture/start 临时开启一个只监听、不登录游戏的
    // 采集服务端，让真实客户端连一次刷新频道声明；采集完成后主连接会自动重连以使用新声明。
    if (config.captureApiEnabled) {
        const capturePort = Number(config.captureApiPort || 25577);
        captureController.configure({
            targetHost: host,
            targetPort: port,
            minecraftVersion: config.minecraftVersion || '26.1.2',
            cacheFile: config.neoforgeProbeCacheFile,
            defaultPort: capturePort,
            defaultTimeoutMs: Number(config.captureApiTimeoutMs || 180000),
            forceOverwrite: config.serverModeCaptureForce === true
        });
        captureController.setReconnectHandler(() => mcClient.reloadNeoForgeProbeCache());
        console.log(`[Capture API] 已启用：POST /capture/start 可在 ${capturePort} 端口开启仅采集服务端（不占用游戏账号）`);
    }

    if (authType === 'microsoft') {
        mcClient.on('connected', () => {
            const session = (mcClient as any).client?.session;
            if (session && session.selectedProfile) {
                console.log(`[Auth] Logged in as: ${session.selectedProfile.name}`);
            }
        });
    }

    // connect() 是异步的：把失败显式记录，避免未处理的 Promise rejection 终止进程
    mcClient.connect().catch((e) => console.error('[Client] Connect failed:', e));
    startApiServer(mcClient, apiPort);

    console.log(`\nMC Player List Checker started.`);
    console.log(`Target Server: ${host}:${port}`);
    console.log(`Auth Type: ${authType}`);
    console.log(`Compression: ${compressionType}`);
    console.log(`Log Level: ${LogLevel[logLevel]}`);
    console.log(`API: http://localhost:${apiPort}/players\n`);
    console.log(`Usage: npx ts-node src/index.ts [host] [port] [username] [loglevel] [--microsoft] [--config path/to/config.json]\n`);
}

bootstrap().catch(console.error);
