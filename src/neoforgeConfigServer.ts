import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as mc from 'minecraft-protocol';

interface NeoForgeChannelDeclaration {
    id: string;
    version: string;
    protocols: string[];
    flow?: 'clientbound' | 'serverbound';
    optional?: boolean;
}

interface NeoForgeProbeState {
    candidates: NeoForgeChannelDeclaration[];
    candidateIndex: number;
}

interface NeoForgeProbeCacheFile {
    version: 1;
    servers: Record<string, {
        updatedAt: string;
        address?: string;
        protocolVersion?: string;
        modLoader?: string;
        declarations: NeoForgeChannelDeclaration[];
        probeStates?: Record<string, NeoForgeProbeState>;
        defaultsByNamespace?: Record<string, Omit<NeoForgeChannelDeclaration, 'id'>>;
    }>;
}

export interface NeoForgeConfigServerOptions {
    listenHost: string;
    listenPort: number;
    targetHost: string;
    targetPort: number;
    minecraftVersion: string;
    cacheFile?: string;
    captureTimeoutMs?: number;
}

const NEOFORGE_INITIAL_CHANNELS = [
    'minecraft:register',
    'minecraft:unregister',
    'neoforge:register',
    'neoforge:network',
    'neoforge:modded_network_setup_failed',
    'c:version',
    'c:register'
];
const NEOFORGE_PROTOCOLS_BY_ORDINAL: Record<number, string> = {
    1: 'play',
    4: 'configuration'
};

function readVarInt(buf: Buffer, offset: { val: number }): number {
    let result = 0;
    let shift = 0;
    while (offset.val < buf.length) {
        const b = buf.readUInt8(offset.val++);
        result |= (b & 0x7F) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
    }
    return result;
}

function writeVarInt(val: number): Buffer {
    const buf = Buffer.alloc(5);
    let offset = 0;
    while (true) {
        let b = val & 0x7F;
        val >>>= 7;
        if (val === 0) {
            buf.writeUInt8(b, offset++);
            break;
        }
        buf.writeUInt8(b | 0x80, offset++);
    }
    return buf.subarray(0, offset);
}

function readString(buf: Buffer, offset: { val: number }): string {
    const length = readVarInt(buf, offset);
    const str = buf.toString('utf8', offset.val, offset.val + length);
    offset.val += length;
    return str;
}

function writeString(str: string): Buffer {
    const strBuf = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function writeStringSet(values: string[]): Buffer {
    return Buffer.concat([
        writeVarInt(values.length),
        ...values.map(value => writeString(value))
    ]);
}

function writeDinnerboneChannels(channels: string[]): Buffer {
    return Buffer.from(channels.map(channel => `${channel}\0`).join(''), 'utf8');
}

function createEmptyNeoForgeModdedNetworkQueryPayload(): Buffer {
    return writeVarInt(0);
}

function uniqueValues(values: string[]): string[] {
    return Array.from(new Set(values.filter(value => value.length > 0)));
}

function normalizeDeclaration(channel: NeoForgeChannelDeclaration): NeoForgeChannelDeclaration {
    const protocols = uniqueValues(channel.protocols.map(protocol => protocol.toLowerCase()));
    return {
        id: channel.id,
        version: String(channel.version || '1'),
        protocols: protocols.length > 0 ? protocols : ['play'],
        flow: channel.flow === 'clientbound' || channel.flow === 'serverbound' ? channel.flow : undefined,
        optional: channel.optional === true
    };
}

function parseNeoForgeRegisterPayload(payload: Buffer): NeoForgeChannelDeclaration[] {
    const offset = { val: 0 };
    const grouped = new Map<string, NeoForgeChannelDeclaration>();
    const protocolCount = readVarInt(payload, offset);

    for (let i = 0; i < protocolCount && offset.val < payload.length; i++) {
        const protocolOrdinal = readVarInt(payload, offset);
        const protocol = NEOFORGE_PROTOCOLS_BY_ORDINAL[protocolOrdinal] || `unknown-${protocolOrdinal}`;
        const channelCount = readVarInt(payload, offset);

        for (let j = 0; j < channelCount && offset.val < payload.length; j++) {
            const id = readString(payload, offset);
            const version = readString(payload, offset);
            const hasFlow = payload.readUInt8(offset.val++) !== 0;
            let flow: 'clientbound' | 'serverbound' | undefined;
            if (hasFlow) {
                flow = readVarInt(payload, offset) === 0 ? 'serverbound' : 'clientbound';
            }
            const optional = payload.readUInt8(offset.val++) !== 0;
            const key = `${id}|${version}|${flow || 'both'}|${optional}`;
            const existing = grouped.get(key);

            if (existing) {
                existing.protocols = uniqueValues([...existing.protocols, protocol]);
            } else {
                grouped.set(key, {
                    id,
                    version,
                    protocols: [protocol],
                    flow,
                    optional
                });
            }
        }
    }

    return Array.from(grouped.values())
        .map(normalizeDeclaration)
        .sort((a, b) => a.id.localeCompare(b.id));
}

function getProtocolVersion(minecraftVersion: string): string {
    const mcData = require('minecraft-data')(minecraftVersion);
    return String(mcData.version.version);
}

function getCacheKey(targetHost: string, targetPort: number, protocolVersion: string): string {
    const source = `${targetHost.toLowerCase()}:${targetPort}_${protocolVersion}`;
    return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function getCachePath(cacheFile?: string): string {
    return cacheFile ? path.resolve(cacheFile) : path.join(process.cwd(), '.neoforge_probe_cache.json');
}

function readCache(cachePath: string): NeoForgeProbeCacheFile {
    if (!fs.existsSync(cachePath)) return { version: 1, servers: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (parsed?.version === 1 && parsed.servers && typeof parsed.servers === 'object') {
            return parsed as NeoForgeProbeCacheFile;
        }
    } catch (e) {
        console.warn(`[NeoForge Capture] Failed to read cache: ${(e as Error).message}`);
    }

    return { version: 1, servers: {} };
}

function writeCache(cachePath: string, cache: NeoForgeProbeCacheFile) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

function saveCapturedDeclarations(options: NeoForgeConfigServerOptions, declarations: NeoForgeChannelDeclaration[]) {
    const protocolVersion = getProtocolVersion(options.minecraftVersion);
    const cacheKey = getCacheKey(options.targetHost, options.targetPort, protocolVersion);
    const cachePath = getCachePath(options.cacheFile);
    const cache = readCache(cachePath);
    const probeStates: Record<string, NeoForgeProbeState> = {};
    const defaultsByNamespace: Record<string, Omit<NeoForgeChannelDeclaration, 'id'>> = {};

    for (const declaration of declarations) {
        probeStates[declaration.id] = {
            candidates: [declaration],
            candidateIndex: 0
        };
        const namespace = declaration.id.split(':', 1)[0];
        defaultsByNamespace[namespace] = {
            version: declaration.version,
            protocols: declaration.protocols,
            flow: declaration.flow,
            optional: declaration.optional
        };
    }

    cache.servers[cacheKey] = {
        updatedAt: new Date().toISOString(),
        address: `${options.targetHost.toLowerCase()}:${options.targetPort}`,
        protocolVersion,
        modLoader: 'neoforge',
        declarations,
        probeStates,
        defaultsByNamespace
    };

    writeCache(cachePath, cache);
    console.log(`[NeoForge Capture] Saved ${declarations.length} declarations to ${cachePath} (${cacheKey})`);
}

function startCaptureHandshake(client: any, options: NeoForgeConfigServerOptions, finish: () => void) {
    let completed = false;
    const timeout = setTimeout(() => {
        if (completed) return;
        completed = true;
        console.warn('[NeoForge Capture] Timed out waiting for neoforge:register');
        finish();
    }, options.captureTimeoutMs ?? 15000);

    const complete = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        finish();
    };

    client.on('custom_payload', (packet: any) => {
        const channel = String(packet.channel || '');
        const data = packet.data as Buffer | undefined;
        if (channel === 'c:version') {
            console.log('[NeoForge Capture] Client replied c:version');
        } else if (channel === 'c:register') {
            console.log('[NeoForge Capture] Client replied c:register');
        } else if (channel === 'neoforge:register') {
            try {
                const declarations = parseNeoForgeRegisterPayload(data ?? Buffer.alloc(0));
                saveCapturedDeclarations(options, declarations);
                complete();
            } catch (e) {
                console.error(`[NeoForge Capture] Failed to parse neoforge:register: ${(e as Error).message}`);
                complete();
            }
        }
    });

    client.write('custom_payload', {
        channel: 'minecraft:register',
        data: writeDinnerboneChannels(NEOFORGE_INITIAL_CHANNELS)
    });
    client.write('custom_payload', {
        channel: 'neoforge:register',
        data: createEmptyNeoForgeModdedNetworkQueryPayload()
    });
    console.log('[NeoForge Capture] Sent NeoForge modded network query to client');
}

function installCaptureBeforeFinish(client: any, options: NeoForgeConfigServerOptions) {
    const originalWrite = client.write;
    let captureStarted = false;

    client.write = function patchedWrite(packetName: string, params: any) {
        if (packetName === 'finish_configuration' && !captureStarted) {
            captureStarted = true;
            startCaptureHandshake(client, options, () => {
                console.log('[NeoForge Capture] Continuing configuration after capture');
                originalWrite.call(client, packetName, params);
            });
            return;
        }

        return originalWrite.call(this, packetName, params);
    };
}

export function startNeoForgeConfigServer(options: NeoForgeConfigServerOptions) {
    const server = mc.createServer({
        host: options.listenHost,
        port: options.listenPort,
        version: options.minecraftVersion,
        motd: 'NeoForge Config Capture',
        'online-mode': false,
        hideErrors: true,
        beforeLogin: (client: any) => installCaptureBeforeFinish(client, options)
    });

    server.on('listening', () => {
        console.log('\n--- NeoForge Config Capture Server ---');
        console.log(`Listen: ${options.listenHost}:${options.listenPort}`);
        console.log(`Target cache key source: ${options.targetHost}:${options.targetPort}_${getProtocolVersion(options.minecraftVersion)}`);
        console.log(`Minecraft Version: ${options.minecraftVersion}`);
        console.log('Connect with a real NeoForge client once to capture mod payload declarations.\n');
    });

    server.on('login', (client: any) => {
        console.log(`[NeoForge Capture] Client logged in: ${client.username}`);
    });

    server.on('error', (err: Error) => {
        console.error(`[NeoForge Capture] Server error: ${err.message}`);
    });

    return server;
}
