import * as fs from 'fs';
import * as path from 'path';
import { initDb } from './db';
import { MCClient, LogLevel } from './mcClient';
import { CompressionType } from './compression';
import { startApiServer } from './api';
import { startNeoForgeConfigServer } from './neoforgeConfigServer';

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
            minecraftVersion: config.minecraftVersion || '1.21.1',
            cacheFile: config.neoforgeProbeCacheFile,
            captureTimeoutMs: config.serverModeCaptureTimeoutMs
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
    if (config.hideErrors !== undefined) mcClient.clientOptions.hideErrors = config.hideErrors;

    if (authType === 'microsoft') {
        mcClient.on('connected', () => {
            const session = (mcClient as any).client?.session;
            if (session && session.selectedProfile) {
                console.log(`[Auth] Logged in as: ${session.selectedProfile.name}`);
            }
        });
    }

    mcClient.connect();
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
