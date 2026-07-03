import * as mc from 'minecraft-protocol';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { applyCompression, CompressionType } from './compression';

const DEFAULT_MC_VERSION = '1.21.1';
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const DEFAULT_NEOFORGE_PROBE_RETRY_DELAY_MS = 1000;
const DEFAULT_NEOFORGE_PROBE_MAX_CHANNELS = 1024;
const DEFAULT_MINECRAFT_SESSION_JOIN_MIN_INTERVAL_MS = 3000;
const DEFAULT_MINECRAFT_SESSION_JOIN_RATE_LIMIT_BACKOFF_MS = 15000;
const DEFAULT_TPS_FALLBACK_IDLE_MS = 30_000;
const DEFAULT_TPS_FALLBACK_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_TPS_FALLBACK_RESPONSE_WINDOW_MS = 5_000;
const DEFAULT_TPS_FALLBACK_MIN_COOLDOWN_MS = 60_000;
const NEOFORGE_COMMON_NETWORK_VERSION = 1;
const NEOFORGE_INITIAL_CHANNELS = [
    'minecraft:register',
    'minecraft:unregister',
    'neoforge:register',
    'neoforge:network',
    'neoforge:modded_network_setup_failed',
    'c:version',
    'c:register'
];
const NEOFORGE_PROTOCOL_ORDINALS: Record<string, number> = {
    play: 1,
    configuration: 4
};

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

export enum LogLevel {
    SILENT = 0,
    ERR = 1,
    WARN = 2,
    INFO = 3,
    DEBUG = 4,
    VERBOSE = 5,
    TRACE = 6
}

export interface Player {
    uuid: string;
    username: string;
    latency: number;
}

export interface ServerStatus {
    online: boolean;
    version?: string;
    protocol?: number;
    motd?: string;
    playersOnline: number;
    playersMax: number;
    isForge: boolean;
    isNeoForge?: boolean;
    modLoader?: 'vanilla' | 'forge' | 'neoforge' | 'modded';
    fmlVersion?: string;
    mods?: string[];
    tps?: string;
    mspt?: string;
}

export class MCClient extends EventEmitter {
    private static yggdrasilJoinThrottlePatched = false;
    private static yggdrasilJoinQueue: Promise<void> = Promise.resolve();
    private static nextYggdrasilJoinAt = 0;
    private client: mc.Client | null = null;
    private players: Map<string, Player> = new Map();
    private host: string;
    private port: number;
    private username: string;
    private status: ServerStatus = { online: false, playersOnline: 0, playersMax: 0, isForge: false };
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private logLevel: LogLevel = LogLevel.INFO;
    private uuidToName: Map<string, string> = new Map();
    private authType: 'microsoft' | 'mojang' = 'mojang';
    private botUuid: string | null = null;
    private compressionType: CompressionType = 'zlib';
    private serverModVersions: Map<string, string> = new Map();
    private neoForgeProbeChannels: Map<string, NeoForgeProbeState> = new Map();
    private neoForgeAcceptedChannels: Map<string, NeoForgeChannelDeclaration> = new Map();
    private neoForgeProbeDefaultsByNamespace: Map<string, Omit<NeoForgeChannelDeclaration, 'id'>> = new Map();
    private lastNeoForgeFailureChannel: string | null = null;
    private neoForgeProbeCacheKey: string | null = null;
    private neoForgeProbeCacheAddress: string | null = null;
    private neoForgeProbeCacheProtocolVersion: string | null = null;
    private neoForgeProbeCacheModLoader: string | null = null;
    private neoForgePlayCacheSaved = false;
    private pendingNeoForgeProbeReconnect = false;
    private lastTpsUpdateAt = 0;
    private tpsFallbackTimer: NodeJS.Timeout | null = null;
    private tpsCommandPendingUntil = 0;
    private tpsCommandCooldownUntil = 0;
    private tpsCommandSuppressUntil = 0;
    public clientOptions: any = {};

    constructor(host: string, port: number = 25565, username: string = 'PlayerListBot', logLevel: LogLevel = LogLevel.INFO, authType: 'microsoft' | 'mojang' = 'mojang', compressionType: CompressionType = 'zlib') {
        super();
        this.host = host;
        this.port = port;
        this.username = username;
        this.logLevel = logLevel;
        this.authType = authType;
        this.compressionType = compressionType;
        applyCompression(this.compressionType);
    }

    private log(level: LogLevel, message: string) {
        if (this.logLevel === LogLevel.SILENT) return;
        if (level <= this.logLevel || (this.logLevel === LogLevel.ERR && level === LogLevel.ERR)) {
            const prefix = `[${LogLevel[level]}]`;
            if (level === LogLevel.ERR) {
                console.error(`${prefix} ${message}`);
            } else if (level === LogLevel.WARN) {
                console.warn(`${prefix} ${message}`);
            } else {
                console.log(`${prefix} ${message}`);
            }
        }
    }

    private estimatePacketSize(packetName: string, params: any): number | undefined {
        try {
            const serializer = (this.client as any)?.serializer;
            if (serializer?.createPacketBuffer) {
                return serializer.createPacketBuffer({ name: packetName, params }).length;
            }
        } catch {
            // Fall back to a stable approximation below.
        }

        try {
            if (params?.data instanceof Buffer) return params.data.length;
            const json = JSON.stringify(params, (_key, value) => {
                if (typeof value === 'bigint') return value.toString();
                if (Buffer.isBuffer(value)) return `<Buffer:${value.length}>`;
                return value;
            });
            return json ? Buffer.byteLength(json) : 0;
        } catch {
            return undefined;
        }
    }

    private tracePacket(direction: 'C->S' | 'S->C', state: string | undefined, packetName: string, size?: number, details?: string) {
        if (this.logLevel < LogLevel.TRACE) return;
        const sizeText = size === undefined ? 'unknown' : `${size} bytes`;
        const suffix = details ? ` ${details}` : '';
        this.log(LogLevel.TRACE, `[Packet ${direction}] state=${state || 'unknown'} name=${packetName} size=${sizeText}${suffix}`);
    }

    private decodeFML3Data(encodedData: string): Buffer {
        const size0 = encodedData.charCodeAt(0);
        const size1 = encodedData.charCodeAt(1);
        const size = size0 | (size1 << 15);

        const packageData: number[] = [];
        let stringIndex = 2;
        let buffer = 0;
        let bitsInBuf = 0;

        while (stringIndex < encodedData.length) {
            while (bitsInBuf >= 8) {
                packageData.push(buffer & 0xFF);
                buffer >>= 8;
                bitsInBuf -= 8;
            }

            const c = encodedData.charCodeAt(stringIndex);
            buffer |= (c & 0x7FFF) << bitsInBuf;
            bitsInBuf += 15;
            stringIndex++;
        }

        while (packageData.length < size) {
            packageData.push(buffer & 0xFF);
            buffer >>= 8;
            bitsInBuf -= 8;
        }

        return Buffer.from(packageData.slice(0, size));
    }

    private isNbtTagged(obj: any): boolean {
        return !!obj && typeof obj === 'object'
            && typeof obj.type === 'string'
            && 'value' in obj
            && ['compound', 'list', 'string', 'byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'intArray', 'longArray'].includes(obj.type);
    }

    // 1.20.5+ uses NBT-encoded text components on the wire (prismarine-nbt shape:
    // { type: 'compound', value: { text: { type: 'string', value: '...' }, extra: { type: 'list', value: { type, value: [...] } } } }).
    // Flatten that back into a plain JSON-style component object so the rest of the extractor can operate uniformly.
    private simplifyNbtComponent(obj: any): any {
        if (!this.isNbtTagged(obj)) return obj;
        const type = obj.type;
        const value = obj.value;
        if (type === 'compound') {
            const out: any = {};
            for (const key of Object.keys(value || {})) {
                out[key] = this.simplifyNbtComponent(value[key]);
            }
            return out;
        }
        if (type === 'list') {
            const items = Array.isArray(value?.value) ? value.value : [];
            const innerType = value?.type;
            return items.map((v: any) => this.simplifyNbtComponent(innerType ? { type: innerType, value: v } : v));
        }
        return value;
    }

    private extractTextFromComponent(obj: any): string {
        if (obj === null || obj === undefined) return '';
        if (typeof obj === 'string') {
            const trimmed = obj.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
                try { return this.extractTextFromComponent(JSON.parse(obj)); } catch { return obj; }
            }
            return obj;
        }
        if (typeof obj !== 'object') return String(obj);
        if (Array.isArray(obj)) {
            return obj.map(e => this.extractTextFromComponent(e)).join('');
        }
        if (this.isNbtTagged(obj)) {
            return this.extractTextFromComponent(this.simplifyNbtComponent(obj));
        }
        // NBT lists of compounds sometimes wrap a primitive entry as {"" : primitive}
        // (this is how vanilla encodes a plain-string component inside a list of
        // compounds, e.g. the message body in chat.type.text). Unwrap it so the
        // rest of the extractor sees the actual primitive.
        const keys = Object.keys(obj);
        if (keys.length === 1 && keys[0] === '') {
            return this.extractTextFromComponent((obj as any)['']);
        }

        let text = typeof obj.text === 'string' ? obj.text : '';
        if (obj.translate) {
            const args: string[] = Array.isArray(obj.with) ? obj.with.map((w: any) => this.extractTextFromComponent(w)) : [];
            const fallback = typeof obj.fallback === 'string' ? obj.fallback : undefined;
            text += this.formatTranslate(obj.translate, args, fallback);
        }
        if (Array.isArray(obj.extra)) {
            for (const e of obj.extra) {
                text += this.extractTextFromComponent(e);
            }
        }
        return text;
    }

    // Renders a translate component. Preference order:
    //   1. `fallback` string from the packet (server-supplied English template, e.g. "<%s> %s")
    //   2. A handful of well-known vanilla keys hard-coded below
    //   3. "<key> arg1 arg2 ..." — preserved so the TPS fallback parser can still recognise
    //      commands.neoforge.tps.* lines if a server ever sends them without a fallback.
    private formatTranslate(key: string, args: string[], fallback?: string): string {
        if (fallback) return this.applyTranslateTemplate(fallback, args);
        const a = (i: number) => args[i] ?? '';
        switch (key) {
            case 'chat.type.text':
            case 'chat.type.text.narrate':
                return `<${a(0)}> ${a(1)}`;
            case 'chat.type.announcement':
                return `[${a(0)}] ${a(1)}`;
            case 'chat.type.emote':
                return `* ${a(0)} ${a(1)}`;
            case 'chat.type.admin':
                return `[${a(0)}: ${a(1)}]`;
            case 'chat.type.team.text':
            case 'chat.type.team.sent':
                return `${a(0)} <${a(1)}> ${a(2)}`;
            case 'multiplayer.player.joined':
                return `${a(0)} joined the game`;
            case 'multiplayer.player.left':
                return `${a(0)} left the game`;
            case 'commands.message.display.incoming':
                return `${a(0)} whispers to you: ${a(1)}`;
            case 'commands.message.display.outgoing':
                return `you whisper to ${a(0)}: ${a(1)}`;
            default:
                return args.length > 0 ? `${key} ${args.join(' ')}` : key;
        }
    }

    // Substitutes Minecraft-style format specifiers (%s, %1$s, %d) used in vanilla
    // language templates. We treat any %... specifier as a positional %s; positional
    // indices are 1-based when explicit, otherwise auto-incremented.
    private applyTranslateTemplate(template: string, args: string[]): string {
        let auto = 0;
        return template.replace(/%(?:(\d+)\$)?[a-zA-Z]/g, (_match, idx) => {
            const i = idx !== undefined ? parseInt(idx, 10) - 1 : auto++;
            return args[i] ?? '';
        });
    }

    private readVarInt(buf: Buffer, offset: { val: number }): number {
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

    private writeVarInt(val: number): Buffer {
        const buf = Buffer.alloc(5);
        let offset = 0;
        while (true) {
            let b = val & 0x7F;
            val >>>= 7;
            if (val === 0) {
                buf.writeUInt8(b, offset++);
                break;
            } else {
                buf.writeUInt8(b | 0x80, offset++);
            }
        }
        return buf.subarray(0, offset);
    }

    private readString(buf: Buffer, offset: { val: number }): string {
        const length = this.readVarInt(buf, offset);
        const str = buf.toString('utf8', offset.val, offset.val + length);
        offset.val += length;
        return str;
    }

    private writeString(str: string): Buffer {
        const strBuf = Buffer.from(str, 'utf8');
        return Buffer.concat([this.writeVarInt(strBuf.length), strBuf]);
    }

    private writeBool(value: boolean): Buffer {
        return Buffer.from([value ? 1 : 0]);
    }

    private writeStringSet(values: string[]): Buffer {
        return Buffer.concat([
            this.writeVarInt(values.length),
            ...values.map(v => this.writeString(v))
        ]);
    }

    private writeDinnerboneChannels(channels: string[]): Buffer {
        return Buffer.from(channels.map(channel => `${channel}\0`).join(''), 'utf8');
    }

    private wrapFmlLoginPayload(channel: string, payload: Buffer): Buffer {
        return Buffer.concat([
            this.writeString(channel),
            this.writeVarInt(payload.length),
            payload
        ]);
    }

    private createKnownForgeLoginReply(channel: string, packetID: number, payload: Buffer): Buffer | null {
        // Zeta sends S2CLoginFlag as discriminator 98 and expects C2SLoginFlag as
        // discriminator 99. Both packets carry the same public fields, so echoing
        // the decoded field payload is enough for the server to advance login.
        if (channel === 'zeta:main' && packetID === 98) {
            return Buffer.concat([this.writeVarInt(99), payload]);
        }
        return null;
    }

    private traceCustomPayload(direction: 'C->S' | 'S->C', state: string | undefined, packet: any, size?: number) {
        const channel = String(packet?.channel ?? 'unknown');
        const data = packet?.data;
        const dataLength = Buffer.isBuffer(data) ? data.length : undefined;
        const detail = dataLength === undefined
            ? `channel=${channel}`
            : `channel=${channel} data=${dataLength} bytes`;
        this.tracePacket(direction, state, 'custom_payload', size, detail);
    }

    private uniqueValues(values: string[]): string[] {
        return Array.from(new Set(values.filter(v => v.length > 0)));
    }

    private normalizeNeoForgeDeclaration(channel: NeoForgeChannelDeclaration): NeoForgeChannelDeclaration {
        const protocols = Array.isArray(channel.protocols)
            ? this.uniqueValues(channel.protocols.map(protocol => String(protocol).toLowerCase()))
            : ['configuration', 'play'];

        return {
            id: channel.id,
            version: String(channel.version ?? '1'),
            protocols: protocols.length > 0 ? protocols : ['configuration', 'play'],
            flow: channel.flow === 'clientbound' || channel.flow === 'serverbound' ? channel.flow : undefined,
            optional: channel.optional === true
        };
    }

    private getNeoForgeProbeCachePath(): string {
        const configured = this.clientOptions.neoforgeProbeCacheFile;
        return configured
            ? path.resolve(String(configured))
            : path.join(process.cwd(), '.neoforge_probe_cache.json');
    }

    private readNeoForgeProbeCache(): NeoForgeProbeCacheFile {
        const cachePath = this.getNeoForgeProbeCachePath();
        if (!fs.existsSync(cachePath)) return { version: 1, servers: {} };

        try {
            const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (parsed?.version === 1 && parsed.servers && typeof parsed.servers === 'object') {
                return parsed as NeoForgeProbeCacheFile;
            }
        } catch (e) {
            this.log(LogLevel.WARN, `[NeoForge Probe] Failed to read probe cache: ${(e as Error).message}`);
        }

        return { version: 1, servers: {} };
    }

    private writeNeoForgeProbeCache(cache: NeoForgeProbeCacheFile) {
        const cachePath = this.getNeoForgeProbeCachePath();
        try {
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
        } catch (e) {
            this.log(LogLevel.WARN, `[NeoForge Probe] Failed to write probe cache: ${(e as Error).message}`);
        }
    }

    private getNeoForgeProbeAddress(): string {
        return `${this.host.toLowerCase()}:${this.port}`;
    }

    private getNeoForgeProbeProtocolVersion(resolvedVersion: string, protocol?: number): string {
        return protocol ? String(protocol) : resolvedVersion;
    }

    private getNeoForgeProbeCacheKey(resolvedVersion: string, protocol?: number): string {
        const source = `${this.getNeoForgeProbeAddress()}_${this.getNeoForgeProbeProtocolVersion(resolvedVersion, protocol)}`;
        return createHash('sha256').update(source).digest('hex').slice(0, 16);
    }

    private normalizeNeoForgeProbeState(rawState: NeoForgeProbeState | undefined, channelId: string): NeoForgeProbeState | undefined {
        if (!rawState || !Array.isArray(rawState.candidates) || rawState.candidates.length === 0) return undefined;

        const candidates = rawState.candidates
            .filter(candidate => candidate && typeof candidate.id === 'string')
            .map(candidate => this.normalizeNeoForgeDeclaration({
                ...candidate,
                id: candidate.id || channelId
            }));
        if (candidates.length === 0) return undefined;

        const requestedIndex = Number(rawState.candidateIndex);
        const candidateIndex = Number.isFinite(requestedIndex)
            ? Math.max(0, Math.min(candidates.length - 1, requestedIndex))
            : 0;

        return { candidates, candidateIndex };
    }

    private loadNeoForgeProbeCache(resolvedVersion: string, modLoader: string, protocol?: number) {
        if (modLoader !== 'neoforge') return;

        const nextKey = this.getNeoForgeProbeCacheKey(resolvedVersion, protocol);
        if (this.neoForgeProbeCacheKey && this.neoForgeProbeCacheKey !== nextKey) {
            this.neoForgeProbeChannels.clear();
            this.neoForgeAcceptedChannels.clear();
            this.neoForgeProbeDefaultsByNamespace.clear();
            this.lastNeoForgeFailureChannel = null;
        }

        this.neoForgeProbeCacheKey = nextKey;
        this.neoForgeProbeCacheAddress = this.getNeoForgeProbeAddress();
        this.neoForgeProbeCacheProtocolVersion = this.getNeoForgeProbeProtocolVersion(resolvedVersion, protocol);
        this.neoForgeProbeCacheModLoader = modLoader;
        const cache = this.readNeoForgeProbeCache();
        const serverCache = cache.servers[this.neoForgeProbeCacheKey];
        if (!serverCache) return;

        let loaded = 0;
        for (const [channelId, rawState] of Object.entries(serverCache.probeStates || {})) {
            const state = this.normalizeNeoForgeProbeState(rawState, channelId);
            if (!state) continue;
            this.neoForgeProbeChannels.set(channelId, state);
            loaded++;
        }

        for (const raw of serverCache.declarations || []) {
            if (!raw || typeof raw.id !== 'string') continue;
            const declaration = this.normalizeNeoForgeDeclaration(raw);
            if (!this.neoForgeProbeChannels.has(declaration.id)) {
                const candidates = this.getNeoForgeProbeCandidates(declaration.id, declaration.version);
                const candidateIndex = Math.max(0, candidates.findIndex(candidate =>
                    candidate.version === declaration.version &&
                    candidate.protocols.join('+') === declaration.protocols.join('+') &&
                    (candidate.flow || '') === (declaration.flow || '')
                ));
                this.neoForgeProbeChannels.set(declaration.id, {
                    candidates: candidates.length > 0 ? candidates : [declaration],
                    candidateIndex
                });
                loaded++;
            }
            this.neoForgeAcceptedChannels.set(declaration.id, declaration);
        }

        for (const [namespace, rawDefault] of Object.entries(serverCache.defaultsByNamespace || {})) {
            if (!rawDefault || !Array.isArray(rawDefault.protocols)) continue;
            this.neoForgeProbeDefaultsByNamespace.set(namespace, {
                version: String(rawDefault.version ?? '1'),
                protocols: this.uniqueValues(rawDefault.protocols.map(protocol => String(protocol).toLowerCase())),
                flow: rawDefault.flow === 'clientbound' || rawDefault.flow === 'serverbound' ? rawDefault.flow : undefined,
                optional: rawDefault.optional === true
            });
        }

        if (loaded > 0) {
            this.log(LogLevel.INFO, `[NeoForge Probe] Loaded ${loaded} cached channel probe states (${this.neoForgeProbeCacheKey})`);
        }
    }

    private markNeoForgeChannelAccepted(channel: NeoForgeChannelDeclaration) {
        const declaration = this.normalizeNeoForgeDeclaration(channel);
        this.neoForgeAcceptedChannels.set(declaration.id, declaration);

        const namespace = declaration.id.split(':', 1)[0];
        this.neoForgeProbeDefaultsByNamespace.set(namespace, {
            version: declaration.version,
            protocols: declaration.protocols,
            flow: declaration.flow,
            optional: declaration.optional
        });
    }

    private markAllNeoForgeProbeChannelsAccepted() {
        for (const state of this.neoForgeProbeChannels.values()) {
            const declaration = state.candidates[state.candidateIndex];
            if (declaration) this.markNeoForgeChannelAccepted(declaration);
        }
        this.saveNeoForgeProbeCache();
    }

    private saveNeoForgeProbeCache() {
        if (!this.neoForgeProbeCacheKey) return;

        const cache = this.readNeoForgeProbeCache();
        const existing = cache.servers[this.neoForgeProbeCacheKey];
        const declarations = new Map<string, NeoForgeChannelDeclaration>();
        const probeStates: Record<string, NeoForgeProbeState> = {};

        for (const declaration of existing?.declarations || []) {
            if (declaration?.id) declarations.set(declaration.id, this.normalizeNeoForgeDeclaration(declaration));
        }
        for (const declaration of this.neoForgeAcceptedChannels.values()) {
            declarations.set(declaration.id, this.normalizeNeoForgeDeclaration(declaration));
        }
        for (const [channelId, state] of this.neoForgeProbeChannels) {
            const normalizedState = this.normalizeNeoForgeProbeState(state, channelId);
            if (normalizedState) probeStates[channelId] = normalizedState;
        }

        const defaultsByNamespace: Record<string, Omit<NeoForgeChannelDeclaration, 'id'>> = {};
        for (const [namespace, value] of this.neoForgeProbeDefaultsByNamespace) {
            defaultsByNamespace[namespace] = {
                version: value.version,
                protocols: value.protocols,
                flow: value.flow,
                optional: value.optional
            };
        }

        cache.servers[this.neoForgeProbeCacheKey] = {
            updatedAt: new Date().toISOString(),
            address: this.neoForgeProbeCacheAddress ?? this.getNeoForgeProbeAddress(),
            protocolVersion: this.neoForgeProbeCacheProtocolVersion ?? undefined,
            modLoader: this.neoForgeProbeCacheModLoader ?? undefined,
            declarations: Array.from(declarations.values()).sort((a, b) => a.id.localeCompare(b.id)),
            probeStates,
            defaultsByNamespace
        };
        this.writeNeoForgeProbeCache(cache);
        this.log(LogLevel.DEBUG, `[NeoForge Probe] Saved ${declarations.size} accepted channels and ${Object.keys(probeStates).length} probe states to cache (${this.neoForgeProbeCacheKey})`);
    }

    private createNeoForgeCommonVersionPayload(): Buffer {
        return Buffer.concat([
            this.writeVarInt(1),
            this.writeVarInt(NEOFORGE_COMMON_NETWORK_VERSION)
        ]);
    }

    private createNeoForgeCommonRegisterPayload(): Buffer {
        return Buffer.concat([
            this.writeVarInt(NEOFORGE_COMMON_NETWORK_VERSION),
            this.writeString('play'),
            this.writeStringSet([])
        ]);
    }

    private getNeoForgeChannelDeclarations(): NeoForgeChannelDeclaration[] {
        const configured = this.clientOptions.neoforgeChannels;
        const declarations: NeoForgeChannelDeclaration[] = [];

        if (Array.isArray(configured)) {
            declarations.push(...configured.flatMap((entry: any) => {
                if (typeof entry === 'string') {
                    return [{
                        id: entry,
                        version: '1',
                        protocols: ['configuration', 'play']
                    }];
                }
                if (!entry || typeof entry.id !== 'string') return [];

                return [{
                    id: entry.id,
                    version: String(entry.version ?? '1'),
                    protocols: Array.isArray(entry.protocols) ? entry.protocols.map((p: any) => String(p).toLowerCase()) : ['configuration', 'play'],
                    flow: entry.flow === 'clientbound' || entry.flow === 'serverbound' ? entry.flow : undefined,
                    optional: entry.optional === true
                }];
            }));
        }

        const configuredIds = new Set(declarations.map(declaration => declaration.id));
        for (const state of this.neoForgeProbeChannels.values()) {
            const declaration = state.candidates[state.candidateIndex];
            if (declaration && !configuredIds.has(declaration.id)) {
                declarations.push(declaration);
            }
        }

        return declarations;
    }

    private writeNeoForgeQueryComponent(channel: NeoForgeChannelDeclaration): Buffer {
        const flowBuffers: Buffer[] = [this.writeBool(!!channel.flow)];
        if (channel.flow) {
            flowBuffers.push(this.writeVarInt(channel.flow === 'serverbound' ? 0 : 1));
        }

        return Buffer.concat([
            this.writeString(channel.id),
            this.writeString(channel.version),
            ...flowBuffers,
            this.writeBool(channel.optional === true)
        ]);
    }

    private createNeoForgeModdedNetworkQueryPayload(): Buffer {
        const byProtocol = new Map<number, NeoForgeChannelDeclaration[]>();
        for (const channel of this.getNeoForgeChannelDeclarations()) {
            for (const protocol of channel.protocols) {
                const ordinal = NEOFORGE_PROTOCOL_ORDINALS[protocol];
                if (ordinal === undefined) continue;
                const channels = byProtocol.get(ordinal) ?? [];
                channels.push(channel);
                byProtocol.set(ordinal, channels);
            }
        }

        const parts: Buffer[] = [this.writeVarInt(byProtocol.size)];
        for (const [protocol, channels] of byProtocol) {
            parts.push(this.writeVarInt(protocol));
            parts.push(this.writeVarInt(channels.length));
            parts.push(...channels.map(channel => this.writeNeoForgeQueryComponent(channel)));
        }

        return Buffer.concat(parts);
    }

    private isNeoForgeProbeEnabled(): boolean {
        return this.clientOptions.neoforgeProbe !== false;
    }

    private getNeoForgeProbeRetryDelayMs(): number {
        const configured = Number(this.clientOptions.neoforgeProbeRetryDelayMs);
        return Number.isFinite(configured) && configured >= 0
            ? configured
            : DEFAULT_NEOFORGE_PROBE_RETRY_DELAY_MS;
    }

    private getNeoForgeProbeMaxChannels(): number {
        const configured = Number(this.clientOptions.neoforgeProbeMaxChannels);
        return Number.isFinite(configured) && configured >= 0
            ? configured
            : DEFAULT_NEOFORGE_PROBE_MAX_CHANNELS;
    }

    private getMinecraftSessionJoinMinIntervalMs(): number {
        const configured = Number(this.clientOptions.minecraftSessionJoinMinIntervalMs);
        return Number.isFinite(configured) && configured >= 0
            ? configured
            : DEFAULT_MINECRAFT_SESSION_JOIN_MIN_INTERVAL_MS;
    }

    private getMinecraftSessionJoinRateLimitBackoffMs(): number {
        const configured = Number(this.clientOptions.minecraftSessionJoinRateLimitBackoffMs);
        return Number.isFinite(configured) && configured >= 0
            ? configured
            : DEFAULT_MINECRAFT_SESSION_JOIN_RATE_LIMIT_BACKOFF_MS;
    }

    private configureYggdrasilJoinThrottle(modLoader: string) {
        const enabled = this.clientOptions.minecraftSessionJoinThrottle !== false &&
            modLoader === 'neoforge' &&
            this.isNeoForgeProbeEnabled();

        (globalThis as any).__mcplcYggdrasilJoinThrottle = {
            enabled,
            minIntervalMs: enabled ? this.getMinecraftSessionJoinMinIntervalMs() : 0,
            rateLimitBackoffMs: enabled ? this.getMinecraftSessionJoinRateLimitBackoffMs() : 0,
            log: (message: string) => this.log(LogLevel.WARN, message)
        };

        this.patchYggdrasilJoinThrottle();
    }

    private patchYggdrasilJoinThrottle() {
        if (MCClient.yggdrasilJoinThrottlePatched) return;

        const yggdrasil = require('yggdrasil');
        const originalServer = yggdrasil.server;
        yggdrasil.server = function patchedServer(...serverArgs: any[]) {
            const server = originalServer.apply(this, serverArgs);
            const originalJoin = server.join.bind(server);

            server.join = function throttledJoin(...joinArgs: any[]) {
                const cb = typeof joinArgs[5] === 'function' ? joinArgs[5] : undefined;
                const callArgs = joinArgs.slice(0, 5);

                const run = async () => {
                    const throttle = (globalThis as any).__mcplcYggdrasilJoinThrottle || {};
                    const minIntervalMs = throttle.enabled ? Number(throttle.minIntervalMs || 0) : 0;
                    if (minIntervalMs > 0) {
                        const waitMs = Math.max(0, MCClient.nextYggdrasilJoinAt - Date.now());
                        if (waitMs > 0) {
                            throttle.log?.(`[Auth] Waiting ${waitMs}ms before session join to avoid rate limits`);
                            await new Promise(resolve => setTimeout(resolve, waitMs));
                        }
                        MCClient.nextYggdrasilJoinAt = Date.now() + minIntervalMs;
                    }

                    try {
                        return await new Promise((resolve, reject) => {
                            originalJoin(...callArgs, (err: Error | undefined, data: any) => {
                                if (err) reject(err);
                                else resolve(data);
                            });
                        });
                    } catch (e) {
                        const err = e as Error;
                        const throttle = (globalThis as any).__mcplcYggdrasilJoinThrottle || {};
                        const backoffMs = throttle.enabled ? Number(throttle.rateLimitBackoffMs || 0) : 0;
                        if (backoffMs > 0 && /ratelimiter|rate limit/i.test(err.message || '')) {
                            MCClient.nextYggdrasilJoinAt = Math.max(MCClient.nextYggdrasilJoinAt, Date.now() + backoffMs);
                            throttle.log?.(`[Auth] Session join was rate-limited; backing off ${backoffMs}ms`);
                        }
                        throw err;
                    }
                };

                const job = MCClient.yggdrasilJoinQueue.then(run, run);
                MCClient.yggdrasilJoinQueue = job.then(() => undefined, () => undefined);

                if (cb) {
                    job.then(data => cb(undefined, data), err => cb(err));
                }
                return job;
            };

            return server;
        };

        MCClient.yggdrasilJoinThrottlePatched = true;
    }

    private scheduleReconnect(defaultDelayMs: number) {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        let delayMs = this.pendingNeoForgeProbeReconnect
            ? this.getNeoForgeProbeRetryDelayMs()
            : defaultDelayMs;
        this.pendingNeoForgeProbeReconnect = false;

        const authWaitMs = this.getPendingYggdrasilJoinWaitMs();
        if (authWaitMs > delayMs) {
            this.log(LogLevel.WARN, `[Auth] Delaying reconnect ${authWaitMs}ms until session join throttle clears`);
            delayMs = authWaitMs;
        }

        this.reconnectTimeout = setTimeout(() => this.connect(), delayMs);
    }

    private getPendingYggdrasilJoinWaitMs(): number {
        const throttle = (globalThis as any).__mcplcYggdrasilJoinThrottle || {};
        if (!throttle.enabled) return 0;
        return Math.max(0, MCClient.nextYggdrasilJoinAt - Date.now());
    }

    private getNeoForgeProbeVersionCandidates(channelId: string, hintedVersion?: string): string[] {
        const namespace = channelId.split(':', 1)[0];
        const modVersion = this.serverModVersions.get(namespace);
        const versions: string[] = [];

        if (hintedVersion) versions.push(hintedVersion);
        if (modVersion) {
            versions.push(modVersion);
            const semver = modVersion.match(/\d+(?:\.\d+){1,3}/)?.[0];
            if (semver) versions.push(semver);
        }

        versions.push('1');
        return this.uniqueValues(versions);
    }

    private getNeoForgeProbeCandidateKey(channel: NeoForgeChannelDeclaration): string {
        return `${channel.version}|${channel.protocols.join('+')}|${channel.flow || 'both'}|${channel.optional === true ? 'optional' : 'required'}`;
    }

    private extendNeoForgeProbeCandidates(channelId: string, state: NeoForgeProbeState, hintedVersion?: string): number {
        const existing = new Set(state.candidates.map(candidate => this.getNeoForgeProbeCandidateKey(candidate)));
        const additions = this.getNeoForgeProbeCandidates(channelId, hintedVersion)
            .filter(candidate => !existing.has(this.getNeoForgeProbeCandidateKey(candidate)));

        if (additions.length > 0) {
            state.candidates.push(...additions);
        }

        return additions.length;
    }

    private getNeoForgeProbeCandidates(channelId: string, hintedVersion?: string): NeoForgeChannelDeclaration[] {
        const shapes: Array<Omit<NeoForgeChannelDeclaration, 'id' | 'version' | 'optional'>> = [
            { protocols: ['play'], flow: 'serverbound' },
            { protocols: ['play'], flow: 'clientbound' },
            { protocols: ['configuration', 'play'] },
            { protocols: ['play'] },
            { protocols: ['configuration'], flow: 'serverbound' },
            { protocols: ['configuration'], flow: 'clientbound' },
            { protocols: ['configuration'] },
            { protocols: ['configuration', 'play'], flow: 'serverbound' },
            { protocols: ['configuration', 'play'], flow: 'clientbound' }
        ];

        const candidates: NeoForgeChannelDeclaration[] = [];
        const namespace = channelId.split(':', 1)[0];
        const namespaceDefault = this.neoForgeProbeDefaultsByNamespace.get(namespace);
        if (namespaceDefault) {
            candidates.push({
                id: channelId,
                ...namespaceDefault
            });
        }

        for (const version of this.getNeoForgeProbeVersionCandidates(channelId, hintedVersion)) {
            for (const shape of shapes) {
                for (const optional of [false, true]) {
                    candidates.push({
                        id: channelId,
                        version,
                        protocols: shape.protocols,
                        flow: shape.flow,
                        optional
                    });
                }
            }
        }

        const seen = new Set<string>();
        return candidates.filter(candidate => {
            const key = this.getNeoForgeProbeCandidateKey(candidate);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private noteNeoForgeProbeProgress(failedChannelId: string) {
        if (!this.lastNeoForgeFailureChannel || this.lastNeoForgeFailureChannel === failedChannelId) {
            this.lastNeoForgeFailureChannel = failedChannelId;
            return;
        }

        const previous = this.neoForgeProbeChannels.get(this.lastNeoForgeFailureChannel);
        const accepted = previous?.candidates[previous.candidateIndex];
        if (accepted) {
            const namespace = accepted.id.split(':', 1)[0];
            this.markNeoForgeChannelAccepted(accepted);
            this.saveNeoForgeProbeCache();
            this.log(LogLevel.DEBUG, `[NeoForge Probe] ${accepted.id} accepted; ${namespace}:* will try protocols=${accepted.protocols.join('+')}, flow=${accepted.flow || 'both'}, version=${accepted.version} first`);
        }

        this.lastNeoForgeFailureChannel = failedChannelId;
    }

    private handleNeoForgeProbeFailure(channelId: string, hintedVersion?: string): boolean {
        if (!this.isNeoForgeProbeEnabled()) return false;
        this.noteNeoForgeProbeProgress(channelId);

        const existing = this.neoForgeProbeChannels.get(channelId);
        if (existing) {
            const addedCandidates = this.extendNeoForgeProbeCandidates(channelId, existing, hintedVersion);
            if (addedCandidates > 0) {
                this.log(LogLevel.DEBUG, `[NeoForge Probe] Expanded candidate set for ${channelId} by ${addedCandidates}`);
            }

            if (existing.candidateIndex + 1 >= existing.candidates.length) {
                this.log(LogLevel.ERR, `[NeoForge Probe] Exhausted candidates for ${channelId}`);
                return false;
            }

            existing.candidateIndex++;
            const next = existing.candidates[existing.candidateIndex];
            this.saveNeoForgeProbeCache();
            this.log(LogLevel.WARN, `[NeoForge Probe] Retrying ${channelId} as version=${next.version}, protocols=${next.protocols.join('+')}, flow=${next.flow || 'both'}`);
            return true;
        }

        const candidates = this.getNeoForgeProbeCandidates(channelId, hintedVersion);
        if (candidates.length === 0) return false;
        const maxProbeChannels = this.getNeoForgeProbeMaxChannels();
        if (this.neoForgeProbeChannels.size >= maxProbeChannels) {
            this.log(LogLevel.ERR, `[NeoForge Probe] Reached channel probe limit (${maxProbeChannels})`);
            return false;
        }

        this.neoForgeProbeChannels.set(channelId, { candidates, candidateIndex: 0 });
        const first = candidates[0];
        this.saveNeoForgeProbeCache();
        this.log(LogLevel.WARN, `[NeoForge Probe] Learned required channel ${channelId}; trying version=${first.version}, protocols=${first.protocols.join('+')}, flow=${first.flow || 'both'}`);
        return true;
    }

    private collectNeoForgeSetupChannels(setup: Buffer | undefined): string[] {
        if (!setup || setup.length === 0) return [];

        try {
            const offset = { val: 0 };
            const channels = new Set<string>();
            const protocolCount = this.readVarInt(setup, offset);

            for (let i = 0; i < protocolCount && offset.val < setup.length; i++) {
                this.readVarInt(setup, offset); // ConnectionProtocol ordinal
                const channelCount = this.readVarInt(setup, offset);

                for (let j = 0; j < channelCount && offset.val < setup.length; j++) {
                    const mapKey = this.readString(setup, offset);
                    const channelId = this.readString(setup, offset);
                    this.readString(setup, offset); // negotiated version

                    channels.add(mapKey);
                    channels.add(channelId);
                }
            }

            return Array.from(channels);
        } catch (e) {
            this.log(LogLevel.WARN, `[NeoForge] Failed to parse network setup channels: ${(e as Error).message}`);
            return [];
        }
    }

    private collectNeoForgeFailureChannels(payload: Buffer | undefined): string[] {
        if (!payload || payload.length === 0) return [];

        try {
            const offset = { val: 0 };
            const count = this.readVarInt(payload, offset);
            if (count <= 0 || offset.val >= payload.length) return [];
            return [this.readString(payload, offset)];
        } catch (e) {
            this.log(LogLevel.WARN, `[NeoForge] Failed to parse setup failure payload: ${(e as Error).message}`);
            return [];
        }
    }

    private collectNeoForgeFailureVersionHint(payload: Buffer | undefined): string | undefined {
        if (!payload || payload.length === 0) return undefined;

        const printable = payload
            .toString('utf8')
            .match(/[A-Za-z0-9_.:+-]{1,96}/g) ?? [];

        return printable.find(value =>
            /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9_.-]+)?$/.test(value)
        );
    }

    private resolveMinecraftVersion(status: ServerStatus): string {
        const versionFromName = status.version?.match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0];
        if (versionFromName) {
            try {
                if (require('minecraft-data')(versionFromName)) return versionFromName;
            } catch (e) {
                this.log(LogLevel.DEBUG, `Unsupported advertised version name ${versionFromName}, falling back to protocol lookup`);
            }
        }

        if (status.protocol) {
            const minecraftData = require('minecraft-data');
            const versions = minecraftData.postNettyVersionsByProtocolVersion?.pc?.[status.protocol] as { minecraftVersion: string }[] | undefined;
            const matched = versions?.find(v => v.minecraftVersion === DEFAULT_MC_VERSION) ?? versions?.[0];
            if (matched) return matched.minecraftVersion;
        }

        return DEFAULT_MC_VERSION;
    }

    private getForcedModLoader(): ServerStatus['modLoader'] | undefined {
        const value = String(this.clientOptions.modLoader || '').toLowerCase();
        if (value === 'neoforge' || value === 'forge' || value === 'vanilla' || value === 'modded') return value;
        return undefined;
    }

    private async ping(): Promise<ServerStatus> {
        return new Promise((resolve) => {
            mc.ping({ host: this.host, port: this.port }, (err, response: any) => {
                if (err) {
                    resolve({ online: false, playersOnline: 0, playersMax: 0, isForge: false });
                } else {
                    const res = response as any;
                    const versionName = String(res.version?.name || '');
                    const hasForgeData = !!res.forgeData;
                    const isNeoForge = /neoforge/i.test(versionName);
                    const isForge = !isNeoForge && (!!hasForgeData || /forge/i.test(versionName) || res.isModded === true);
                    const modLoader: ServerStatus['modLoader'] = isNeoForge ? 'neoforge' : (isForge ? 'forge' : (hasForgeData ? 'modded' : 'vanilla'));

                    const mods = new Map<string, string>();
                    if (res.forgeData && res.forgeData.d) {
                        try {
                            const dataBuf = this.decodeFML3Data(res.forgeData.d);
                            const offset = { val: 0 };

                            offset.val++; // truncated (bool)
                            if (offset.val + 2 <= dataBuf.length) {
                                const modsSize = dataBuf.readUInt16LE(offset.val);
                                offset.val += 2;

                                for (let i = 0; i < modsSize; i++) {
                                    if (offset.val >= dataBuf.length) break;

                                    const channelSizeAndVersionFlag = this.readVarInt(dataBuf, offset);
                                    const isIgnoreServerOnly = (channelSizeAndVersionFlag & 0x01) !== 0;
                                    const channelSize = channelSizeAndVersionFlag >> 1;

                                    const modId = this.readString(dataBuf, offset);
                                    const modVersion = isIgnoreServerOnly ? 'IGNORED' : this.readString(dataBuf, offset);

                                    for (let j = 0; j < channelSize; j++) {
                                        if (offset.val >= dataBuf.length) break;
                                        this.readString(dataBuf, offset); // channelName
                                        this.readString(dataBuf, offset); // channelVersion
                                        offset.val++; // requiredOnClient (bool)
                                    }
                                    mods.set(modId, modVersion);
                                }
                            }
                        } catch (e) {
                            console.error('Failed to decode FML3 data:', e);
                        }
                    }
                    this.serverModVersions = mods;

                    resolve({
                        online: true,
                        version: res.version?.name,
                        protocol: res.version?.protocol,
                        motd: typeof res.description === 'string' ? res.description : (res.description?.text || ''),
                        playersOnline: res.players?.online,
                        playersMax: res.players?.max,
                        isForge,
                        isNeoForge,
                        modLoader,
                        fmlVersion: res.forgeData ? 'FML3' : undefined,
                        mods: Array.from(mods.keys())
                    });
                }
            });
        });
    }

    public async connect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.cleanup();

        const status = await this.ping();
        const forcedModLoader = this.getForcedModLoader();
        if (forcedModLoader) {
            status.modLoader = forcedModLoader;
            status.isForge = forcedModLoader === 'forge';
            status.isNeoForge = forcedModLoader === 'neoforge';
        }
        this.status = status;
        this.emitStatusUpdate();

        if (!status.online) {
            console.log('Server is offline, waiting 10s...');
            this.reconnectTimeout = setTimeout(() => this.connect(), 10000);
            return;
        }

        const resolvedVersion = this.resolveMinecraftVersion(status);
        const modLoader = status.modLoader || (status.isNeoForge ? 'neoforge' : (status.isForge ? 'forge' : 'vanilla'));
        console.log(`Connection attempt: ${modLoader} (${resolvedVersion})`);
        this.loadNeoForgeProbeCache(resolvedVersion, modLoader, status.protocol);
        this.neoForgePlayCacheSaved = false;
        this.configureYggdrasilJoinThrottle(modLoader);

        // FML3 marker for modern Forge. NeoForge 1.21.1 uses configuration custom payload negotiation below.
        const fmlMarker = '\0FML3\0';
        const serverHost = status.isForge ? `${this.host}${fmlMarker}` : this.host;

        const options: any = {
            host: this.host,
            port: this.port,
            username: this.username,
            version: resolvedVersion,
            serverHost: this.host, // Use clean host initially
            auth: this.authType,
            profilesFolder: './.minecraft_auth', // Enable built-in auth caching
            hideErrors: true, // Suppress packet parsing errors (e.g. declare_commands on modded servers)
            ...this.clientOptions
        };

        // Patch protodef FullPacketParser to skip ALL parse errors (not just PartialReadError).
        // Without this, non-PartialReadError exceptions (e.g. TypeError from tryCatch returning
        // undefined) destroy the stream pipeline and kill the socket connection.
        const { FullPacketParser } = require('protodef');
        if (!FullPacketParser.prototype.__patchedTransform) {
            const origTransform = FullPacketParser.prototype._transform;
            FullPacketParser.prototype._transform = function (chunk: Buffer, enc: string, cb: Function) {
                origTransform.call(this, chunk, enc, (err?: Error) => {
                    if (err) {
                        if (!this.noErrorLogging) {
                            console.warn('[Packet] Parse error (skipped):', (err as any).message || err);
                        }
                        return cb();
                    }
                    cb();
                });
            };
            FullPacketParser.prototype.__patchedTransform = true;
        }

        this.client = mc.createClient(options);

        // CORE FIX: Intercept outgoing packets
        const oldWrite = this.client.write;
        const allowedEmptyLoginPluginResponses = new Set<number>();
        const sendLoginPluginResponse = (messageId: number, data?: Buffer) => {
            if (data === undefined || data.length === 0) {
                allowedEmptyLoginPluginResponses.add(messageId);
            }

            const params = data === undefined
                ? { messageId }
                : { messageId, data };
            this.client?.write('login_plugin_response', params);
        };
        this.client.write = (packetName, params) => {
            // 1. Bypass hostname truncation
            if (packetName === 'set_protocol') {
                params.serverHost = serverHost;
                console.log(`[Handshake] Force serverHost: ${JSON.stringify(params.serverHost)}`);
            }

            // 2. BLOCK LIBRARY AUTO-RESPONSES
            // Library sends empty data (params.data length undefined or 0) for unknown plugin requests.
            // These cause "unexpected index 0" errors because FML3 expects wrapped packets.
            if (packetName === 'login_plugin_response') {
                if (!params.data || params.data.length === 0) {
                    if (allowedEmptyLoginPluginResponses.has(params.messageId)) {
                        allowedEmptyLoginPluginResponses.delete(params.messageId);
                    } else {
                        // console.log(`[Plugin] Blocking auto-response for ID ${params.messageId}`);
                        return; // DO NOT SEND
                    }
                }
            }

            const outgoingSize = this.estimatePacketSize(String(packetName), params);
            if (packetName === 'custom_payload') {
                this.traceCustomPayload('C->S', String(this.client?.state), params, outgoingSize);
            } else {
                this.tracePacket('C->S', String(this.client?.state), String(packetName), outgoingSize);
            }
            return oldWrite.call(this.client, packetName, params);
        };

        this.client.on('packet', (data, meta, buffer?: Buffer, fullBuffer?: Buffer) => {
            if (meta.name === 'custom_payload') {
                this.traceCustomPayload('S->C', String(this.client?.state), data, fullBuffer?.length ?? buffer?.length);
            } else {
                this.tracePacket('S->C', String(this.client?.state), String(meta.name), fullBuffer?.length ?? buffer?.length);
            }

            if (meta.name === 'ping' && String(this.client?.state) === 'configuration') {
                this.client?.write('pong', { id: (data as any).id });
                this.log(LogLevel.DEBUG, `[Config] Replied pong ${String((data as any).id)}`);
                return;
            }

            if (!this.neoForgePlayCacheSaved && modLoader === 'neoforge' && String(this.client?.state) === 'play') {
                this.neoForgePlayCacheSaved = true;
                this.markAllNeoForgeProbeChannelsAccepted();
                this.log(LogLevel.INFO, '[NeoForge Probe] Negotiation reached play state; cached active probe declarations');
            }

            if (meta.name === 'disconnect' || meta.name === 'kick_disconnect') {
                this.log(LogLevel.ERR, `Disconnected: ${JSON.stringify(data)}`);
            }
            // Safe debug logging for play state to catch player disconnects
            const noise = ['keep_alive', 'update_time', 'rel_entity_move', 'entity_metadata', 'map_chunk', 'custom_payload', 'world_event', 'sound_effect', 'entity_teleport', 'entity_velocity'];
            if (this.client?.state === 'play' && !noise.includes(meta.name)) {
                if (this.logLevel < LogLevel.TRACE) {
                    this.log(LogLevel.DEBUG, `Packet: ${meta.name}`);
                    try {
                        const dataStr = data ? JSON.stringify(data).slice(0, 150) : 'undefined';
                        this.log(LogLevel.VERBOSE, `Packet Data (${meta.name}): ${dataStr}`);
                    } catch (e) {
                        this.log(LogLevel.VERBOSE, `Packet Data (${meta.name}): [JSON Error]`);
                    }
                }
            }
        });

        this.client.on('custom_payload', (packet) => {
            const client = this.client;
            const channel = packet.channel;
            if (!client || String(client.state) !== 'configuration') return;

            if (channel === 'c:version') {
                client.write('custom_payload', {
                    channel: 'c:version',
                    data: this.createNeoForgeCommonVersionPayload()
                });
                this.log(LogLevel.DEBUG, '[NeoForge] Replied c:version with common network version 1');
            } else if (channel === 'c:register') {
                client.write('custom_payload', {
                    channel: 'c:register',
                    data: this.createNeoForgeCommonRegisterPayload()
                });
                this.log(LogLevel.DEBUG, '[NeoForge] Replied c:register with no common play channels');
            } else if (channel === 'neoforge:register') {
                const queryPayload = this.createNeoForgeModdedNetworkQueryPayload();
                client.write('custom_payload', {
                    channel: 'neoforge:register',
                    data: queryPayload
                });
                this.log(LogLevel.DEBUG, `[NeoForge] Sent ${this.getNeoForgeChannelDeclarations().length} configured modded channel declarations (${queryPayload.length} bytes)`);
            } else if (channel === 'neoforge:network') {
                const setupChannels = this.collectNeoForgeSetupChannels(packet.data as Buffer | undefined);
                const registeredChannels = Array.from(new Set([...NEOFORGE_INITIAL_CHANNELS, ...setupChannels]));
                client.write('custom_payload', {
                    channel: 'minecraft:register',
                    data: this.writeDinnerboneChannels(registeredChannels)
                });
                this.log(LogLevel.DEBUG, `[NeoForge] Registered ${registeredChannels.length} negotiated channels`);
            } else if (channel === 'minecraft:brand') {
                client.write('custom_payload', {
                    channel: 'minecraft:brand',
                    data: this.writeString('mcplayerlistchecker')
                });
                this.log(LogLevel.DEBUG, '[Config] Sent client brand');
            } else if (channel === 'neoforge:frozen_registry_sync_completed') {
                client.write('custom_payload', {
                    channel: 'neoforge:frozen_registry_sync_completed',
                    data: Buffer.alloc(0)
                });
                this.log(LogLevel.DEBUG, '[NeoForge] Acknowledged frozen registry sync completion');
            } else if (channel === 'neoforge:known_registry_data_maps') {
                client.write('custom_payload', {
                    channel: 'neoforge:known_registry_data_maps_reply',
                    data: this.writeVarInt(0)
                });
                this.log(LogLevel.DEBUG, '[NeoForge] Replied with no known registry data maps');
            } else if (channel === 'neoforge:feature_flags') {
                client.write('custom_payload', {
                    channel: 'neoforge:feature_flags_ack',
                    data: Buffer.alloc(0)
                });
                this.log(LogLevel.DEBUG, '[NeoForge] Acknowledged NeoForge feature flags');
            } else if (channel === 'neoforge:extensible_enum_data') {
                client.write('custom_payload', {
                    channel: 'neoforge:extensible_enum_ack',
                    data: Buffer.alloc(0)
                });
                this.log(LogLevel.DEBUG, '[NeoForge] Acknowledged extensible enum data');
            } else if (channel === 'fabric:accepted_attachments_v1') {
                client.write('custom_payload', {
                    channel: 'fabric:accepted_attachments_v1',
                    data: this.writeVarInt(0)
                });
                this.log(LogLevel.DEBUG, '[Fabric] Replied with no accepted attachments');
            } else if (channel === 'neoforge:modded_network_setup_failed') {
                const failures = this.collectNeoForgeFailureChannels(packet.data as Buffer | undefined);
                const versionHint = this.collectNeoForgeFailureVersionHint(packet.data as Buffer | undefined);
                const probeUpdated = failures.some(failure => this.handleNeoForgeProbeFailure(failure, versionHint));
                const suffix = failures.length > 0 ? ` Missing/incompatible channel: ${failures.join(', ')}` : '';
                if (probeUpdated) {
                    this.pendingNeoForgeProbeReconnect = true;
                    const hint = versionHint ? ` Version hint: ${versionHint}.` : '';
                    this.log(LogLevel.WARN, `[NeoForge] Server rejected modded network negotiation.${suffix}${hint} Probe will retry in ${this.getNeoForgeProbeRetryDelayMs()}ms.`);
                } else {
                    this.log(LogLevel.ERR, `[NeoForge] Server rejected modded network negotiation.${suffix}`);
                }
            }
        });

        this.client.on('login_plugin_request', (packet) => {
            console.log(`[Plugin] Request: ${packet.channel} (ID: ${packet.messageId})`);

            if (packet.channel === 'fml:login_wrapper' || packet.channel === 'fml:loginwrapper') {
                const buf = packet.data as Buffer;
                if (!buf || buf.length === 0) {
                    this.log(LogLevel.DEBUG, '[Handshake] Empty FML login wrapper; no response sent');
                    return;
                }

                try {
                    const offset = { val: 0 };
                    const fmlChannel = this.readString(buf, offset);
                    const innerLen = this.readVarInt(buf, offset); // Inner packet length
                    const packetID = this.readVarInt(buf, offset);

                    this.log(LogLevel.DEBUG, `[Handshake] FML wrapper channel=${fmlChannel}, packetID=${packetID}, innerLen=${innerLen}`);

                    if (fmlChannel === 'fml:handshake') {
                        let wrappedPayload: Buffer | null = null;

                        if (packetID === 1) { // S2CModList (FML3/FML2)
                            const modCount = this.readVarInt(buf, offset);
                            const mods: string[] = [];
                            for (let i = 0; i < modCount; i++) mods.push(this.readString(buf, offset));

                            const chanCount = this.readVarInt(buf, offset);
                            const chans: { n: string, v: string }[] = [];
                            for (let i = 0; i < chanCount; i++) chans.push({ n: this.readString(buf, offset), v: this.readString(buf, offset) });

                            const regCount = this.readVarInt(buf, offset);
                            const regs: string[] = [];
                            for (let i = 0; i < regCount; i++) regs.push(this.readString(buf, offset));

                            // FML3 optional DataPack Registry
                            if (buf.length > offset.val) {
                                console.log('[Plugin] FML3 DataPack Registry detected, skipping additional fields');
                                // We don't need to read them for the reply, just follow the C# logic
                            }

                            console.log(`[Handshake] ModList: ${modCount} mods, ${chanCount} channels, ${regCount} registries`);

                            // C2SModListReply (ID: 2)
                            // Ref: MCC Protocol18Forge.cs
                            const reply = Buffer.concat([
                                this.writeVarInt(2), // Packet ID
                                this.writeVarInt(modCount),
                                Buffer.concat(mods.map(m => this.writeString(m))),
                                this.writeVarInt(chanCount),
                                Buffer.concat(chans.map(c => Buffer.concat([this.writeString(c.n), this.writeString(c.v)]))),
                                this.writeVarInt(regCount),
                                Buffer.concat(regs.map(r => Buffer.concat([this.writeString(r), this.writeString('')]))) // Version must be empty string
                            ]);

                            wrappedPayload = this.wrapFmlLoginPayload('fml:handshake', reply);
                        } else if (packetID === 3 || packetID === 4) {
                            // RegistryData and ConfigData require a C2S ACK packet.
                            wrappedPayload = this.wrapFmlLoginPayload('fml:handshake', this.writeVarInt(99));
                            this.log(LogLevel.DEBUG, `[Handshake] Sending ACK (99) for PacketID: ${packetID}`);
                        } else if (packetID === 5 || packetID === 6) {
                            // FML3 ModDataList and ChannelMismatchData are informational here.
                            this.log(LogLevel.DEBUG, `[Handshake] Ignoring informational FML3 packet ${packetID}; no response sent`);
                            return;
                        } else {
                            this.log(LogLevel.DEBUG, `[Handshake] Unknown FML handshake packet ${packetID}; no response sent`);
                            return;
                        }

                        if (wrappedPayload) {
                            sendLoginPluginResponse(packet.messageId, wrappedPayload);
                        }
                    } else {
                        const replyPayload = this.createKnownForgeLoginReply(fmlChannel, packetID, buf.subarray(offset.val));
                        if (replyPayload) {
                            this.log(LogLevel.DEBUG, `[Handshake] Replying to known Forge login channel ${fmlChannel} packetID=${packetID}`);
                            sendLoginPluginResponse(packet.messageId, this.wrapFmlLoginPayload(fmlChannel, replyPayload));
                        } else {
                            this.log(LogLevel.DEBUG, `[Handshake] Unknown FML wrapper channel ${fmlChannel}; no response sent`);
                        }
                    }
                } catch (e) {
                    this.log(LogLevel.WARN, `[Handshake] Failed to parse FML login wrapper: ${(e as Error).message}; no response sent`);
                }
            } else {
                // Fallback for other plugin channels: vanilla "not understood" response.
                sendLoginPluginResponse(packet.messageId);
            }
        });

        const removePlayerByUuid = (uuid: string, source: string) => {
            // Try direct match, then normalized match
            let player = this.players.get(uuid);
            let targetUuid = uuid;

            if (!player) {
                const normalized = uuid.toLowerCase();
                const found = Array.from(this.players.keys()).find(k => k.toLowerCase() === normalized);
                if (found) {
                    player = this.players.get(found);
                    targetUuid = found;
                }
            }

            if (player) {
                this.players.delete(targetUuid);
                this.emit('playerLeave', player);
                this.emitStatusUpdate();
                this.log(LogLevel.INFO, `Player Left: ${player.username} (${targetUuid}) [via ${source}]`);
                // Use botUuid for filtering
                if (targetUuid !== this.botUuid) {
                    import('./db').then(db => db.saveLog({ type: 'leave', uuid: targetUuid, username: player!.username, server: this.host }));
                }
            } else {
                this.log(LogLevel.DEBUG, `Remove requested for unknown UUID (${source}): ${uuid}`);
            }
        };

        const handlePlayerInfo = (packet: any, meta: any) => {
            const { action, data } = packet;

            for (const item of data) {
                const uuid = item.uuid || item.UUID;
                if (!uuid || uuid === this.botUuid) continue;

                let actionVal: number;
                if (typeof action === 'number') {
                    actionVal = action;
                } else if (typeof action === 'object' && action._value !== undefined) {
                    actionVal = action._value;
                } else {
                    // Fallback for older versions if action is not a number or object with _value
                    actionVal = action.add_player ? 0 : -1;
                }

                // 0x44 player_info_update bitmask handling
                const bits = actionVal;

                // 0x01: Add Player
                if (bits & 0x01) {
                    const username = item.player?.name || item.name;
                    const latency = item.latency ?? item.ping;
                    if (username) {
                        const player: Player = { uuid, username, latency: latency || 0 };
                        if (!this.players.has(uuid)) {
                            this.players.set(uuid, player);
                            this.uuidToName.set(uuid, username);
                            this.emit('playerJoin', player);
                            this.emitStatusUpdate();
                            this.log(LogLevel.INFO, `Player Joined: ${username} (${uuid})`);
                            if (username !== this.username) {
                                import('./db').then(db => db.saveLog({ type: 'join', uuid, username, server: this.host }));
                            }
                        }
                    }
                }

                // 0x10: Update Latency
                if (bits & 0x10) {
                    const latency = item.latency ?? item.ping;
                    const player = this.players.get(uuid);
                    if (player) {
                        const oldLatency = player.latency;
                        player.latency = latency || 0;
                        this.log(LogLevel.DEBUG, `Player Latency Updated: ${player.username} (${latency}ms)`);
                        if (oldLatency !== player.latency) {
                            this.emit('playerUpdate', { ...player });
                        }
                    }
                }

                if (typeof action === 'string') {
                    if (action === "remove_player") {
                        removePlayerByUuid(uuid, 'PlayerInfo Action: Remove Player');
                    }
                }

            }
        };

        this.client.on('player_info', (packet, meta) => handlePlayerInfo(packet, meta));
        this.client.on('player_info_update', (packet, meta) => handlePlayerInfo(packet, meta));

        this.client.on('player_info_remove', (packet) => {
            const { uuids } = packet;
            this.log(LogLevel.DEBUG, `player_info_remove received: ${JSON.stringify(uuids)}`);
            for (const uuid of uuids) {
                removePlayerByUuid(uuid, 'Remove Packet');
            }
        });

        // Modern Forge/NeoForge packet for removal
        this.client.on('player_remove', (packet) => {
            const { players } = packet;
            this.log(LogLevel.DEBUG, `player_remove received: ${JSON.stringify(players)}`);
            if (Array.isArray(players)) {
                for (const uuid of players) {
                    removePlayerByUuid(uuid, 'PlayerRemove Packet');
                }
            }
        });

        this.client.on('playerlist_header', (packet) => {
            if (packet.footer) {
                try {
                    const textContent = this.extractTextFromComponent(packet.footer).replace(/§[0-9a-fk-or]/g, '');
                    this.log(LogLevel.DEBUG, `Flattened Footer: ${textContent}`);

                    const tpsMatch = textContent.match(/TPS[:\s]*([\d.]+)/i);
                    const msptMatch = textContent.match(/MSPT[:\s]*([\d.]+)/i);

                    if (tpsMatch) this.status.tps = tpsMatch[1];
                    if (msptMatch) this.status.mspt = msptMatch[1];

                    if (tpsMatch || msptMatch) {
                        this.lastTpsUpdateAt = Date.now();
                        this.log(LogLevel.DEBUG, `Extracted from footer - TPS: ${this.status.tps}, MSPT: ${this.status.mspt}`);
                        this.emitStatusUpdate();
                        import('./db').then(db => db.saveHistory({
                            tps: this.status.tps || '0',
                            mspt: this.status.mspt || '0',
                            playerCount: this.players.size,
                            server: this.host
                        }));
                    }
                } catch (e) { }
            }
        });

        // Chat parsing for modern versions (Modern and Legacy)
        this.client.on('system_chat', (packet) => {
            try {
                const text = this.extractTextFromComponent(packet.content).replace(/§[0-9a-fk-or]/g, '');
                const suppressed = this.tryConsumeTpsCommandResponse(text);
                if (suppressed) {
                    this.log(LogLevel.DEBUG, `[TPS Fallback] Suppressed system chat response: ${text}`);
                    return;
                }
                this.log(LogLevel.INFO, `[Chat] (System) ${text}`);
                this.emit('chat', { sender: 'System', message: text });
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] system_chat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('player_chat', (packet) => {
            try {
                const senderUuid = packet.senderUuid;
                // 1.21.1 renames `senderName`/`unsignedContent` to `networkName`/`unsignedChatContent`
                // and ships them as anonymous NBT instead of JSON strings.
                const senderNameComp = packet.networkName ?? packet.senderName ?? null;

                let name = 'Unknown';
                if (senderNameComp) {
                    name = this.extractTextFromComponent(senderNameComp).replace(/§[0-9a-fk-or]/g, '');
                }
                if (!name && senderUuid && this.uuidToName.has(senderUuid)) {
                    name = this.uuidToName.get(senderUuid)!;
                }
                if (!name) name = 'Unknown';

                const unsigned = packet.unsignedChatContent ?? packet.unsignedContent;
                let message = unsigned !== undefined && unsigned !== null
                    ? this.extractTextFromComponent(unsigned)
                    : (packet.plainMessage ?? '');
                const cleanMsg = String(message).replace(/§[0-9a-fk-or]/g, '');
                this.log(LogLevel.INFO, `[Chat] <${name}> ${cleanMsg}`);
                this.emit('chat', { sender: name, message: cleanMsg });
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] player_chat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('chat', (packet) => {
            try {
                const text = this.extractTextFromComponent(packet.message).replace(/§[0-9a-fk-or]/g, '');
                const suppressed = this.tryConsumeTpsCommandResponse(text);
                if (suppressed) {
                    this.log(LogLevel.DEBUG, `[TPS Fallback] Suppressed legacy chat response: ${text}`);
                    return;
                }
                this.log(LogLevel.INFO, `[Chat] ${text}`);
                this.emit('chat', { sender: 'System', message: text });
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] legacy chat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('end', (reason) => {
            this.log(LogLevel.INFO, `Disconnected: ${reason}`);
            this.scheduleReconnect(DEFAULT_RECONNECT_DELAY_MS);
        });

        this.client.on('error', (err: any) => {
            // Non-fatal: packet deserialization errors should not trigger reconnect.
            // These include PartialReadError and "Deserialization error for play.toClient".
            if (err.partialReadError || (err.field && typeof err.field === 'string' && err.field.includes('toClient'))) {
                this.log(LogLevel.WARN, `Packet parse error (non-fatal): ${err.message}`);
                return;
            }
            console.error('Client Error:', err);
            this.log(LogLevel.ERR, `Client Error: ${err.message}`);
            this.scheduleReconnect(DEFAULT_RECONNECT_DELAY_MS);
        });

        this.client.on('success', (packet) => {
            this.log(LogLevel.INFO, `Logged in to ${modLoader} server!`);
            if (this.client) {
                this.username = this.client.username;
                this.botUuid = packet.uuid || this.client.uuid; // Capture bot's own UUID
                this.log(LogLevel.INFO, `BOT Username: ${this.username}, UUID: ${this.botUuid}`);
            }
            this.lastTpsUpdateAt = 0;
            this.tpsCommandPendingUntil = 0;
            this.tpsCommandCooldownUntil = 0;
            this.tpsCommandSuppressUntil = 0;
            this.startTpsFallbackTimer();
            this.emit('connected');
        });
    }

    private cleanup() {
        this.players.clear();
        this.stopTpsFallbackTimer();
        this.tpsCommandPendingUntil = 0;
        this.tpsCommandSuppressUntil = 0;
        this.pendingTpsDimensionResult = null;
        if (this.client) {
            this.client.removeAllListeners();
            this.client = null;
        }
    }

    private startTpsFallbackTimer() {
        this.stopTpsFallbackTimer();
        if (this.clientOptions?.tpsFallbackEnabled === false) return;
        const checkInterval = Number(this.clientOptions?.tpsFallbackCheckIntervalMs ?? DEFAULT_TPS_FALLBACK_CHECK_INTERVAL_MS);
        this.tpsFallbackTimer = setInterval(() => this.evaluateTpsFallback(), checkInterval);
    }

    private stopTpsFallbackTimer() {
        if (this.tpsFallbackTimer) {
            clearInterval(this.tpsFallbackTimer);
            this.tpsFallbackTimer = null;
        }
    }

    private evaluateTpsFallback() {
        if (!this.client || !this.username) return;
        const now = Date.now();
        // If a previous fallback round timed out without an "overall" line, commit the
        // last per-dimension reading we buffered so the watchdog has *something* to use.
        if (this.pendingTpsDimensionResult && now > this.tpsCommandPendingUntil) {
            this.flushPendingTpsDimensionResult();
        }
        const idleThreshold = Number(this.clientOptions?.tpsFallbackIdleMs ?? DEFAULT_TPS_FALLBACK_IDLE_MS);
        const cooldown = Number(this.clientOptions?.tpsFallbackCooldownMs ?? DEFAULT_TPS_FALLBACK_MIN_COOLDOWN_MS);
        if (now < this.tpsCommandCooldownUntil) return;
        if (now < this.tpsCommandPendingUntil) return;
        const lastUpdate = this.lastTpsUpdateAt;
        const idleMs = lastUpdate === 0 ? Number.POSITIVE_INFINITY : now - lastUpdate;
        if (idleMs < idleThreshold) return;

        const command = String(this.clientOptions?.tpsFallbackCommand ?? 'neoforge tps').replace(/^\/+/, '');
        try {
            this.log(LogLevel.DEBUG, `[TPS Fallback] No TPS update for ${idleMs === Infinity ? 'ever' : `${Math.round(idleMs / 1000)}s`}, requesting via /${command}`);
            this.sendCommand(command);
            const responseWindow = Number(this.clientOptions?.tpsFallbackResponseWindowMs ?? DEFAULT_TPS_FALLBACK_RESPONSE_WINDOW_MS);
            this.tpsCommandPendingUntil = now + responseWindow;
            this.tpsCommandSuppressUntil = this.tpsCommandPendingUntil;
            this.tpsCommandCooldownUntil = now + Math.max(cooldown, responseWindow);
        } catch (e) {
            this.log(LogLevel.WARN, `[TPS Fallback] Failed to send command: ${(e as Error).message}`);
            this.tpsCommandCooldownUntil = now + cooldown;
        }
    }

    // Parses TPS / MSPT from chat output of `/neoforge tps` (and the older `/forge tps`).
    // The bot may receive either a rendered English line:
    //   "Overall: 20.000 TPS (19.2 ms/tick)"
    //   "minecraft:overworld: 20.000 TPS (4.2 ms/tick)"
    // or — when the language file isn't loaded client-side — the raw translate key
    // followed by its arguments, joined by spaces (this is what extractTextFromComponent
    // produces for an un-localised translate component):
    //   "commands.neoforge.tps.overall 20.000 19.246"
    //   "commands.neoforge.tps.dimension dimension.minecraft.overworld 20.000 18.468"
    // Within a single fallback round we only commit on the "overall" line, but we
    // remember the most recent dimension line so we can fall back to it if no overall
    // arrives before the response window expires.
    private pendingTpsDimensionResult: { tps: string; mspt?: string } | null = null;

    private tryConsumeTpsCommandResponse(text: string): boolean {
        if (!text) return false;
        const now = Date.now();
        const withinPendingWindow = now <= this.tpsCommandPendingUntil;
        const withinSuppressWindow = now <= this.tpsCommandSuppressUntil;

        if (!withinPendingWindow) {
            // Response window over: commit any pending dimension reading we've buffered.
            this.flushPendingTpsDimensionResult();
            if (!withinSuppressWindow) return false;
        }

        const trimmed = text.trim();
        let tps: string | undefined;
        let mspt: string | undefined;
        let isOverall = false;

        // Translate-key variants (non-localised).
        const overallKey = trimmed.match(/^commands\.(?:neo)?forge\.tps\.overall\s+([\d.]+)\s+([\d.]+)/i);
        if (overallKey) {
            tps = overallKey[1];
            mspt = overallKey[2];
            isOverall = true;
        } else {
            const dimKey = trimmed.match(/^commands\.(?:neo)?forge\.tps\.dimension\s+\S+\s+([\d.]+)\s+([\d.]+)/i);
            if (dimKey) {
                tps = dimKey[1];
                mspt = dimKey[2];
            }
        }

        // Localised variants. NeoForge: "Overall: 20.000 TPS (19.2 ms/tick)"
        // Older Forge wording: "Overall: Mean tick time: 49.8 ms. Mean TPS: 20.000"
        if (!tps) {
            if (/\bOverall\b/i.test(trimmed)) isOverall = true;
            const tpsParen = trimmed.match(/([\d.]+)\s*TPS\s*\(\s*([\d.]+)\s*ms/i);
            if (tpsParen) {
                tps = tpsParen[1];
                mspt = tpsParen[2];
            } else {
                const meanTps = trimmed.match(/Mean\s+TPS\s*[:=]?\s*([\d.]+)/i) || trimmed.match(/\bTPS\s*[:=]\s*([\d.]+)/i);
                if (meanTps) {
                    tps = meanTps[1];
                    const meanMspt = trimmed.match(/Mean\s+tick\s+time\s*[:=]?\s*([\d.]+)/i) || trimmed.match(/\bMSPT\s*[:=]\s*([\d.]+)/i);
                    if (meanMspt) mspt = meanMspt[1];
                }
            }
        }

        if (!tps) {
            return this.isLikelyTpsFallbackCommandFeedback(trimmed);
        }

        if (withinPendingWindow) {
            if (isOverall) {
                this.commitTpsResult(tps, mspt, true);
                this.pendingTpsDimensionResult = null;
                // Stop parsing more readings for this fallback round once we have the overall figure.
                // Keep tpsCommandSuppressUntil intact so trailing command output is still hidden from WS.
                this.tpsCommandPendingUntil = 0;
            } else {
                // Buffer dimension lines; commit only if the response window expires without an "overall".
                this.pendingTpsDimensionResult = { tps, mspt };
            }
        }

        return true;
    }

    private isLikelyTpsFallbackCommandFeedback(text: string): boolean {
        return /commands\.(?:neo)?forge\.tps\./i.test(text)
            || /\b(?:TPS|MSPT|ms\/tick|Mean\s+tick\s+time)\b/i.test(text)
            || /commands\.(?:generic|dispatcher)\./i.test(text)
            || /\b(?:unknown|incomplete)\s+command\b/i.test(text)
            || /\bpermission\b/i.test(text);
    }

    private flushPendingTpsDimensionResult() {
        const pending = this.pendingTpsDimensionResult;
        if (!pending) return;
        this.pendingTpsDimensionResult = null;
        this.commitTpsResult(pending.tps, pending.mspt, false);
    }

    private commitTpsResult(tps: string, mspt: string | undefined, isOverall: boolean) {
        this.status.tps = tps;
        if (mspt) this.status.mspt = mspt;
        this.lastTpsUpdateAt = Date.now();
        this.log(LogLevel.INFO, `[TPS Fallback] Captured TPS=${tps}${mspt ? ` MSPT=${mspt}` : ''}${isOverall ? ' (Overall)' : ''}`);
        this.emitStatusUpdate();
        import('./db').then(db => db.saveHistory({
            tps: this.status.tps || '0',
            mspt: this.status.mspt || '0',
            playerCount: this.players.size,
            server: this.host
        })).catch(() => {});
    }

    private emitStatusUpdate() {
        this.emit('statusUpdate', this.getStatus());
    }

    public sendChat(message: string): void {
        if (!message || typeof message !== 'string') {
            throw new Error('message must be a non-empty string');
        }
        if (message.length > 256) {
            throw new Error('message exceeds 256 character limit');
        }
        if (!this.client) {
            throw new Error('Not connected to server');
        }
        const send = (this.client as any).chat;
        if (typeof send !== 'function') {
            throw new Error('chat function not available on client');
        }
        send.call(this.client, message);
        this.log(LogLevel.INFO, `[Chat] -> ${message}`);
    }

    public sendCommand(command: string): void {
        if (!command || typeof command !== 'string') {
            throw new Error('command must be a non-empty string');
        }
        const trimmed = command.replace(/^\/+/, '').trim();
        if (!trimmed) {
            throw new Error('command must be a non-empty string');
        }
        this.sendChat(`/${trimmed}`);
    }

    public getPlayers(): Player[] {
        return Array.from(this.players.values());
    }

    public getStatus(): ServerStatus {
        return {
            ...this.status,
            playersOnline: this.players.size // Real-time count from active list
        };
    }
}
