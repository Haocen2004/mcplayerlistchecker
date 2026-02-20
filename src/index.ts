import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { initDb } from './db';
import { saveEncrypted, loadEncrypted } from './crypto';
import { MCClient, LogLevel } from './mcClient';
import { startApiServer } from './api';

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

    const logLevel = (LogLevel as any)[logLevelStr] ?? LogLevel.INFO;

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const askSecret = (query: string): Promise<string> => {
        return new Promise((resolve) => {
            process.stdout.write(query);
            const stdin = process.stdin;
            stdin.setRawMode(true);
            stdin.resume();
            let key = "";
            const onData = (chunk: Buffer) => {
                const char = chunk.toString('utf8');
                switch (char) {
                    case "\n": case "\r": case "\u0004":
                        stdin.setRawMode(false);
                        stdin.removeListener('data', onData);
                        process.stdout.write("\n");
                        resolve(key);
                        break;
                    case "\u0003": process.exit(); break;
                    case "\u0008": case "\u007f":
                        if (key.length > 0) key = key.substring(0, key.length - 1);
                        break;
                    default:
                        if (char.length === 1 && char.charCodeAt(0) >= 32) key += char;
                        break;
                }
            };
            stdin.on('data', onData);
        });
    };

    console.log('\n--- MC Player List Checker ---');

    // Initialize DB
    try {
        await initDb(mongoUri, mongoDb);
    } catch (e) {
        console.warn('[DB] Continuing without MongoDB...');
    }

    let encryptionKey = '';
    if (authType === 'microsoft') {
        encryptionKey = await askSecret('Enter Passphrase for Credential Encryption: ');
    }
    rl.close();

    const mcClient = new MCClient(host, port, username, logLevel, authType);

    // MS Auth cache handling
    if (authType === 'microsoft' && encryptionKey) {
        const cached = loadEncrypted(encryptionKey);
        if (cached) {
            console.log('[Auth] Loading cached MS session...');
            mcClient.clientOptions = { ...cached };
        }

        mcClient.on('connected', () => {
            const session = (mcClient as any).client?.session;
            if (session) {
                if (session.selectedProfile) {
                    console.log(`[Auth] Logged in as: ${session.selectedProfile.name}`);
                }
                saveEncrypted(session, encryptionKey);
                console.log('[Auth] Session cached securely.');
            }
        });
    }

    mcClient.connect();
    startApiServer(mcClient, apiPort);

    console.log(`\nMC Player List Checker started.`);
    console.log(`Target Server: ${host}:${port}`);
    console.log(`Auth Type: ${authType}`);
    console.log(`Log Level: ${LogLevel[logLevel]}`);
    console.log(`API: http://localhost:${apiPort}/players\n`);
    console.log(`Usage: npx ts-node src/index.ts [host] [port] [username] [loglevel] [--microsoft] [--config path/to/config.json]\n`);
}

bootstrap().catch(console.error);
