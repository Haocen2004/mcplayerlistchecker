import * as mc from 'minecraft-protocol';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { applyCompression, CompressionType } from './compression';

// 默认目标版本：Minecraft 26.1.2（NeoForge 26.1.x 是 26.1 的 hotfix，协议号同为 775）。
// 26.1/26.1.1/26.1.2 共享 minecraft-data 的 26.1 数据目录，因此该默认值可直接被 minecraft-data 解析。
const DEFAULT_MC_VERSION = '26.1.2';
// 旧版本（1.12.2 Forge、1.21.1 NeoForge）仍受支持，只是不再作为默认值。
const LEGACY_SUPPORTED_MC_VERSIONS = ['1.21.1', '1.21.8', '1.21.11', '1.12.2'];
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const DEFAULT_NEOFORGE_PROBE_RETRY_DELAY_MS = 1000;
const DEFAULT_NEOFORGE_PROBE_MAX_CHANNELS = 1024;
const DEFAULT_MINECRAFT_SESSION_JOIN_MIN_INTERVAL_MS = 3000;
const DEFAULT_MINECRAFT_SESSION_JOIN_RATE_LIMIT_BACKOFF_MS = 15000;
const DEFAULT_TPS_FALLBACK_IDLE_MS = 30_000;
const DEFAULT_TPS_FALLBACK_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_TPS_FALLBACK_RESPONSE_WINDOW_MS = 5_000;
const DEFAULT_TPS_FALLBACK_MIN_COOLDOWN_MS = 60_000;
// minecraft-protocol 的 keepalive 插件默认 30 秒收不到 keep_alive 就主动 end('keepAliveError')。
// 该计时器只由 keep_alive 包刷新（不像原版客户端看任意数据包），网络抖动/丢包重传时容易误断，
// 所以默认放宽到 60 秒，并允许通过 checkTimeoutInterval 配置。
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 60_000;
// 每个收到的包都打 DEBUG 日志在大型模组服上本身就会拖慢事件循环，这里按秒限流。
const DEFAULT_PACKET_LOG_PER_SECOND = 50;
const DEFAULT_STATS_INTERVAL_MS = 30_000;
const PACKET_DATA_LOG_MAX_BYTES = 4_096;
// play 状态下高频且无信息量的包，不打逐包日志
const QUIET_PACKET_NAMES = new Set([
    'keep_alive',
    'update_time',
    'rel_entity_move',
    'entity_metadata',
    'map_chunk',
    'custom_payload',
    'world_event',
    'sound_effect',
    'entity_teleport',
    'entity_velocity',
    'bundle_delimiter',
    'update_light',
    'entity_move_look',
    'entity_head_rotation',
    'sync_entity_position',
    'entity_look',
    'set_ticking_state',
    'step_tick',
    'position',
    'spawn_entity',
    'entity_update_attributes',
    'block_change',
    'chunk_batch_start',
    'chunk_batch_finished'
]);
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
// NeoForge 26.1 起，服务端会向 NeoForge 客户端无条件下发以下 modded payload，而 NetworkRegistry.checkPacket()
// 只允许下发「客户端已声明」的频道（BUILTIN 与 minecraft:* 除外）。未声明时服务端会抛
// UnsupportedOperationException：
//   - configuration 阶段：neoforge:check_extensible_enum 任务无条件下发 neoforge:extensible_enum_data
//     （未声明 → multiplayer.disconnect.configuration_error）
//   - play 阶段：26.1 起配方内容改为通过 modded payload 同步，进入世界后立即下发 neoforge:recipe_content
//     （未声明 → multiplayer.disconnect.invalid_player_data）
// 这些都是单向 payload，客户端收到即可，只需对 extensible_enum_data 回一个空的
// neoforge:extensible_enum_ack（unit codec，无 payload）。
// 不要声明 neoforge:frozen_registry*（会触发 SyncRegistries 注册表全量同步）、
// neoforge:feature_flags 与 neoforge:known_registry_data_maps（服务器的任务会自行检查 hasChannel 并跳过）。
const NEOFORGE_261_REQUIRED_CLIENTBOUND_CHANNELS = [
    'neoforge:extensible_enum_data',
    'neoforge:recipe_content'
];
const NEOFORGE_PROTOCOL_ORDINALS: Record<string, number> = {
    play: 1,
    configuration: 4
};
const LEGACY_FORGE_HANDSHAKE_CHANNEL = 'FML|HS';
const LEGACY_FORGE_CHANNELS = ['FML|HS', 'FML', 'FML|MP', 'FORGE'];
const LEGACY_FORGE_PROTOCOL_VERSION = 2;
const LEGACY_FORGE_MAX_PROTOCOL = 340;

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
    // 正版登录的 cache key 由 minecraft-protocol 传给 prismarine-auth 的 username 决定
    // （见 src/client/microsoftAuth.js: new PrismarineAuth(options.username, ...)）。
    // 登录成功后库里会把 client.username 更新为正版 ID，如果下轮重连继续用它，
    // cache key 就会变化，导致每次都重新要求设备码授权，因此这里固定住初始用户名。
    private authUsername: string;
    private botUuid: string | null = null;
    private compressionType: CompressionType = 'zlib';
    // 连接健康度统计（用于诊断"网络差就断线"这类问题：区分真断网与客户端自身阻塞）
    private lastPacketReceivedAt = 0;
    private receivedPacketCount = 0;
    private sentPacketCount = 0;
    private packetLogWindowStartedAt = 0;
    private packetLogWindowCount = 0;
    private suppressedPacketLogs = 0;
    // 服务端因聊天/命令校验失败断开后置位：本进程内不再发送聊天与命令，避免"被踢—重连"循环
    private chatCommandDisabledReason: string | null = null;
    private chatCommandDisabledLogged = false;
    private eventLoopLagPeakMs = 0;
    private eventLoopTimer: NodeJS.Timeout | null = null;
    private statsTimer: NodeJS.Timeout | null = null;
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
    private recentChatEventKeys: Map<string, number> = new Map();
    private playReady = false;
    private deserializerResetPending = false;
    private legacyForgeHandshakeState: 'idle' | 'waiting_server_data' | 'waiting_server_complete' | 'pending_complete' | 'complete' = 'idle';
    private legacyForgeFmlProtocolVersion = LEGACY_FORGE_PROTOCOL_VERSION;
    private legacyForgeServerMods: Map<string, string> = new Map();
    public clientOptions: any = {};

    constructor(host: string, port: number = 25565, username: string = 'PlayerListBot', logLevel: LogLevel = LogLevel.INFO, authType: 'microsoft' | 'mojang' = 'mojang', compressionType: CompressionType = 'zlib') {
        super();
        this.host = host;
        this.port = port;
        this.username = username;
        this.authUsername = username;
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

    private cleanMinecraftText(text: any): string {
        return String(text ?? '').replace(/§[0-9a-fk-or]/gi, '');
    }

    private extractCleanTextFromComponent(component: any): string {
        return this.cleanMinecraftText(this.extractTextFromComponent(component));
    }

    private firstDefined(...values: any[]): any {
        return values.find(value => value !== undefined && value !== null);
    }

    private resolvePlayerChatSender(packet: any): string {
        const senderUuid = this.firstDefined(packet.senderUuid, packet.sender);
        const senderComponent = this.firstDefined(
            packet.networkName,
            packet.senderName,
            packet.displayName
        );

        let name = senderComponent !== undefined
            ? this.extractCleanTextFromComponent(senderComponent)
            : '';

        if (!name && senderUuid && this.uuidToName.has(senderUuid)) {
            name = this.uuidToName.get(senderUuid)!;
        }

        return name || 'Unknown';
    }

    private resolvePlayerChatMessage(packet: any): string {
        const unsignedComponent = this.firstDefined(
            packet.unsignedChatContent,
            packet.unsignedContent
        );
        const unsignedText = unsignedComponent !== undefined
            ? this.extractCleanTextFromComponent(unsignedComponent)
            : '';
        if (unsignedText) return unsignedText;

        const plainText = this.cleanMinecraftText(packet.plainMessage ?? '');
        if (plainText) return plainText;

        const messageComponent = this.firstDefined(
            packet.signedChatContent,
            packet.formattedMessage,
            packet.message
        );

        return messageComponent !== undefined
            ? this.extractCleanTextFromComponent(messageComponent)
            : '';
    }

    private shouldEmitChatEvent(sender: string, message: string): boolean {
        const now = Date.now();
        for (const [key, timestamp] of this.recentChatEventKeys) {
            if (now - timestamp > 500) this.recentChatEventKeys.delete(key);
        }

        const key = `${sender}\n${message}`;
        if (this.recentChatEventKeys.has(key)) return false;
        this.recentChatEventKeys.set(key, now);
        return true;
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

    // configuration 阶段向服务器声明本端监听的 clientbound 通道：
    // NeoForge 的 BUILTIN_PAYLOADS（协商开始前即可收发的那 7 条）+ NeoForge 26.1 起必须声明的频道
    // + 探测到的 configuration 阶段 modded 频道。
    // 服务器用这份声明决定是否注册 CommonVersion/CommonRegister 任务，所以必须尽早（pong 之前）发送。
    private getNeoForgeConfigurationChannels(): string[] {
        const configurationChannels = this.getNeoForgeChannelDeclarations()
            .filter(declaration => declaration.protocols.includes('configuration'))
            .map(declaration => declaration.id);

        return Array.from(new Set([
            ...NEOFORGE_INITIAL_CHANNELS,
            ...NEOFORGE_261_REQUIRED_CLIENTBOUND_CHANNELS,
            ...configurationChannels
        ]));
    }

    private sendNeoForgeConfigurationChannels(client: mc.Client) {
        const channels = this.getNeoForgeConfigurationChannels();

        client.write('custom_payload', {
            channel: 'minecraft:register',
            data: this.writeDinnerboneChannels(channels)
        });
        this.log(LogLevel.DEBUG, `[NeoForge] Declared ${channels.length} clientbound channels to the server`);
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
        const base = Number.isFinite(configured) && configured >= 0
            ? configured
            : DEFAULT_NEOFORGE_PROBE_MAX_CHANNELS;

        // 大型模组包的缓存声明数可能已经超过上限（实测某整合包有 1927 个频道，而默认上限 1024），
        // 此时任何新频道都会被判定为"达到探测上限"而无法学习。这里按"已加载规模 + 上限"放宽，
        // 既保留配置项作为"单次新增学习量"的约束，又不会因为缓存本来就大而彻底失去学习能力。
        return this.neoForgeProbeChannels.size > base
            ? this.neoForgeProbeChannels.size + base
            : base;
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

        // 同一个 mod 的 payload 版本号通常是统一的（例如 logisticsnetworks 全部从 1 升到 9）。
        // 模组包更新后，缓存里旧频道的版本会整体过时，因此优先复用同命名空间其它已知频道的版本，
        // 能显著提高一轮就命中正确版本的几率。
        const namespaceVersions: string[] = [];
        for (const declaration of this.neoForgeAcceptedChannels.values()) {
            if (declaration.id.split(':', 1)[0] === namespace) namespaceVersions.push(declaration.version);
        }
        for (const [id, state] of this.neoForgeProbeChannels) {
            if (id.split(':', 1)[0] !== namespace) continue;
            const candidate = state.candidates[state.candidateIndex];
            if (candidate) namespaceVersions.push(candidate.version);
        }
        // 出现次数多的版本更可能是该 mod 当前的统一版本，排在前面
        const frequency = new Map<string, number>();
        for (const version of namespaceVersions) {
            frequency.set(version, (frequency.get(version) ?? 0) + 1);
        }
        versions.push(...[...frequency.entries()].sort((a, b) => b[1] - a[1]).map(([version]) => version));

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

    // 从同命名空间其它已知声明推断该 mod 当前统一的声明风格。
    // 模组包更新时，一个 mod 的 payload 通常一起改版本号/协议/方向/必需性，
    // 用众数组合作为首选候选能大幅减少探测轮数（否则会先试缓存里的过期值）。
    private getNeoForgeNamespaceProfile(namespace: string): NeoForgeChannelDeclaration | undefined {
        const declarations: NeoForgeChannelDeclaration[] = [];
        for (const declaration of this.neoForgeAcceptedChannels.values()) {
            if (declaration.id.split(':', 1)[0] === namespace) declarations.push(declaration);
        }
        for (const [id, state] of this.neoForgeProbeChannels) {
            if (id.split(':', 1)[0] !== namespace) continue;
            const candidate = state.candidates[state.candidateIndex];
            if (candidate) declarations.push(candidate);
        }
        if (declarations.length === 0) return undefined;

        const tally = <T>(values: T[]): T => {
            const counts = new Map<string, { value: T; count: number }>();
            for (const value of values) {
                const key = JSON.stringify(value);
                const entry = counts.get(key);
                if (entry) entry.count++;
                else counts.set(key, { value, count: 1 });
            }
            return [...counts.values()].sort((a, b) => b.count - a.count)[0].value;
        };

        const protocols = tally(declarations.map(d => d.protocols.join('+')).concat()).split('+');
        const flow = tally(declarations.map(d => d.flow || 'both'));
        const optional = tally(declarations.map(d => d.optional === true));

        return {
            id: '',
            version: tally(declarations.map(d => d.version)),
            protocols,
            flow: flow === 'both' ? undefined : flow,
            optional
        };
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

        // 首选：该 mod 当前的统一风格（模组包更新后最可能的正确组合）
        const profile = this.getNeoForgeNamespaceProfile(namespace);
        if (profile) {
            candidates.push({
                id: channelId,
                version: profile.version,
                protocols: profile.protocols,
                flow: profile.flow,
                optional: profile.optional
            });
        }

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
            const broadcast = this.broadcastNeoForgeNamespaceProfile(namespace, accepted);
            this.saveNeoForgeProbeCache();
            this.log(LogLevel.DEBUG, `[NeoForge Probe] ${accepted.id} accepted; ${namespace}:* will try protocols=${accepted.protocols.join('+')}, flow=${accepted.flow || 'both'}, version=${accepted.version} first`
                + (broadcast > 0 ? ` (已同步到同命名空间另外 ${broadcast} 个频道)` : ''));
        }

        this.lastNeoForgeFailureChannel = failedChannelId;
    }

    // 某个频道被接受后，把它的版本/协议/方向/必需性推到同命名空间其它频道的候选首位。
    // 模组包更新时一个 mod 的 payload 往往整体变更，这样下一个失败频道可以直接命中正确组合，
    // 避免"每个频道各试十几轮"。
    private broadcastNeoForgeNamespaceProfile(namespace: string, accepted: NeoForgeChannelDeclaration): number {
        let updated = 0;

        for (const [id, state] of this.neoForgeProbeChannels) {
            if (id === accepted.id) continue;
            if (id.split(':', 1)[0] !== namespace) continue;

            const next: NeoForgeChannelDeclaration = {
                id,
                version: accepted.version,
                protocols: accepted.protocols,
                flow: accepted.flow,
                optional: accepted.optional
            };
            const nextKey = this.getNeoForgeProbeCandidateKey(next);
            const current = state.candidates[state.candidateIndex];
            if (current && this.getNeoForgeProbeCandidateKey(current) === nextKey) continue;

            const existingIndex = state.candidates.findIndex(candidate => this.getNeoForgeProbeCandidateKey(candidate) === nextKey);
            if (existingIndex > 0) {
                const [moved] = state.candidates.splice(existingIndex, 1);
                state.candidates.unshift(moved);
            } else if (existingIndex === -1) {
                state.candidates.unshift(next);
            }
            state.candidateIndex = 0;
            updated++;
        }

        return updated;
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
                this.log(LogLevel.WARN, '[NeoForge Probe] 如果服务端模组包刚更新过，缓存里的频道声明可能已过期：'
                    + '建议用真实客户端跑一次采集模式（config.json 设 "mode": "server"，客户端连上来一次）来刷新声明，'
                    + '或删除该服务器的缓存条目后重新探测。');
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
        // 服务器 ping 的版本名可能是 "26.1.2"、"NeoForge 26.1.2"、"Paper 1.21.1" 这类形式，先按数字版本号提取。
        const versionFromName = status.version?.match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0];
        if (versionFromName) {
            try {
                if (require('minecraft-data')(versionFromName)) return versionFromName;
            } catch (e) {
                this.log(LogLevel.DEBUG, `Unsupported advertised version name ${versionFromName}, falling back to protocol lookup`);
            }
        }

        if (status.protocol) {
            // 协议号可能对应多个版本（26.1/26.1.1/26.1.2 同为 775，1.20.1/1.20 同为 763）：
            // 优先选默认版本，其次选正式版（排除 pre/rc/snapshot 这类含字母的条目）。
            // 只返回 minecraft-data 里真正有协议数据的版本，避免选中 26.2 这类"有版本号但无数据目录"
            // 的版本，导致 createClient 抛 unsupported protocol version。
            const minecraftData = require('minecraft-data');
            const versions = minecraftData.postNettyVersionsByProtocolVersion?.pc?.[status.protocol] as { minecraftVersion: string }[] | undefined;
            const releases = versions?.filter(v => !/[a-zA-Z]/.test(v.minecraftVersion)) ?? [];
            const candidates = [
                versions?.find(v => v.minecraftVersion === DEFAULT_MC_VERSION)?.minecraftVersion,
                ...releases.map(v => v.minecraftVersion),
                ...(versions ?? []).map(v => v.minecraftVersion)
            ].filter((candidate): candidate is string => !!candidate);

            for (const candidate of candidates) {
                try {
                    if (minecraftData(candidate)) return candidate;
                } catch {
                    // 忽略无法解析的版本名，继续尝试下一个候选
                }
            }

            this.log(LogLevel.WARN, `[Version] Protocol ${status.protocol} 对应的版本在本机 minecraft-data 中没有协议数据，回退到 ${DEFAULT_MC_VERSION}`);
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
                    const legacyModinfo = res.modinfo?.type === 'FML' && Array.isArray(res.modinfo?.modList)
                        ? res.modinfo
                        : null;
                    const hasForgeData = !!res.forgeData;
                    const hasLegacyForgeData = !!legacyModinfo;
                    const isNeoForge = /neoforge/i.test(versionName);
                    const isForge = !isNeoForge && (hasForgeData || hasLegacyForgeData || /forge/i.test(versionName) || res.isModded === true);
                    const modLoader: ServerStatus['modLoader'] = isNeoForge ? 'neoforge' : (isForge ? 'forge' : (hasForgeData ? 'modded' : 'vanilla'));

                    const mods = new Map<string, string>();
                    if (legacyModinfo) {
                        for (const mod of legacyModinfo.modList) {
                            if (!mod || typeof mod.modid !== 'string') continue;
                            mods.set(mod.modid, String(mod.version ?? ''));
                        }
                    } else if (res.forgeData && res.forgeData.d) {
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
                        fmlVersion: res.forgeData ? 'FML3' : (legacyModinfo ? 'FML' : undefined),
                        mods: Array.from(mods.keys())
                    });
                }
            });
        });
    }

    private compareMinecraftVersion(a: string, b: string): number {
        const parse = (value: string) => value.split('.').map(part => {
            const numeric = parseInt(part, 10);
            return Number.isFinite(numeric) ? numeric : 0;
        });
        const left = parse(a);
        const right = parse(b);
        const length = Math.max(left.length, right.length);

        for (let i = 0; i < length; i++) {
            const diff = (left[i] ?? 0) - (right[i] ?? 0);
            if (diff !== 0) return diff;
        }
        return 0;
    }

    private isLegacyForge(resolvedVersion: string, status: ServerStatus, modLoader: string): boolean {
        if (modLoader !== 'forge') return false;

        const protocol = Number(status.protocol);
        if (Number.isFinite(protocol) && protocol > 0) {
            return protocol <= LEGACY_FORGE_MAX_PROTOCOL;
        }

        return this.compareMinecraftVersion(resolvedVersion, '1.12.2') <= 0;
    }

    private parseLegacyForgeModList(data: Buffer | undefined): Map<string, string> {
        const mods = new Map<string, string>();
        if (!data || data.length < 1) return mods;

        try {
            const offset = { val: 1 }; // skip discriminator
            const count = this.readVarInt(data, offset);
            for (let i = 0; i < count && offset.val < data.length; i++) {
                const modid = this.readString(data, offset);
                const version = this.readString(data, offset);
                mods.set(modid, version);
            }
        } catch (e) {
            this.log(LogLevel.WARN, `[Legacy Forge] Failed to parse mod list: ${(e as Error).message}`);
        }

        return mods;
    }

    private getLegacyForgeClientMods(): Array<{ modid: string; version: string }> {
        const configured = this.clientOptions.legacyForgeMods ?? this.clientOptions.forgeMods;
        if (Array.isArray(configured) && configured.length > 0) {
            const parsed: Array<{ modid: string; version: string }> = [];
            for (const entry of configured) {
                if (typeof entry === 'string') {
                    const separator = entry.includes('@') ? '@' : (entry.includes(':') ? ':' : null);
                    if (separator) {
                        const [modid, version] = entry.split(separator);
                        if (modid) parsed.push({ modid, version: version || '' });
                    } else {
                        parsed.push({ modid: entry, version: '' });
                    }
                } else if (entry && typeof entry.modid === 'string') {
                    parsed.push({ modid: entry.modid, version: String(entry.version ?? '') });
                }
            }
            if (parsed.length > 0) return parsed;
        }

        if (this.legacyForgeServerMods.size > 0) {
            return Array.from(this.legacyForgeServerMods, ([modid, version]) => ({ modid, version }));
        }

        // Fallback for servers that identify as Forge but don't expose a full mod list in the ping.
        return [
            { modid: 'mcp', version: '9.42' },
            { modid: 'FML', version: '8.0.99.99' },
            { modid: 'Forge', version: '14.23.5.2860' }
        ];
    }

    private createLegacyForgeClientHelloPayload(): Buffer {
        return Buffer.from([1, this.legacyForgeFmlProtocolVersion]);
    }

    private createLegacyForgeModListPayload(): Buffer {
        const mods = this.getLegacyForgeClientMods();
        const payloads = mods.map(mod => Buffer.concat([
            this.writeString(mod.modid),
            this.writeString(mod.version)
        ]));

        return Buffer.concat([
            Buffer.from([2]),
            this.writeVarInt(mods.length),
            ...payloads
        ]);
    }

    private createLegacyForgeAckPayload(phase: number): Buffer {
        return Buffer.from([0xff, phase]);
    }

    private handleLegacyForgeHandshake(data: Buffer | undefined) {
        if (!data || data.length === 0) return;

        const discriminator = data.readInt8(0);
        const client = this.client;
        if (!client) return;

        if (discriminator === 0) {
            if (data.length < 2) {
                this.log(LogLevel.WARN, '[Legacy Forge] ServerHello is too short');
                return;
            }

            this.legacyForgeFmlProtocolVersion = data.readUInt8(1) || LEGACY_FORGE_PROTOCOL_VERSION;
            this.legacyForgeHandshakeState = 'waiting_server_data';

            client.write('custom_payload', {
                channel: 'REGISTER',
                data: this.writeDinnerboneChannels(LEGACY_FORGE_CHANNELS)
            });
            client.write('custom_payload', {
                channel: LEGACY_FORGE_HANDSHAKE_CHANNEL,
                data: this.createLegacyForgeClientHelloPayload()
            });
            client.write('custom_payload', {
                channel: LEGACY_FORGE_HANDSHAKE_CHANNEL,
                data: this.createLegacyForgeModListPayload()
            });
            this.log(LogLevel.INFO, `[Legacy Forge] Received ServerHello (FML ${this.legacyForgeFmlProtocolVersion}), sent client handshake`);
            return;
        }

        if (discriminator === 2) {
            const mods = this.parseLegacyForgeModList(data);
            this.legacyForgeServerMods = mods;
            this.log(LogLevel.INFO, `[Legacy Forge] Server has ${mods.size} mods`);

            if (this.legacyForgeHandshakeState === 'waiting_server_data') {
                this.legacyForgeHandshakeState = 'waiting_server_complete';
                client.write('custom_payload', {
                    channel: LEGACY_FORGE_HANDSHAKE_CHANNEL,
                    data: this.createLegacyForgeAckPayload(2)
                });
                this.log(LogLevel.DEBUG, '[Legacy Forge] Accepted server mod list, waiting for registry data');
            }
            return;
        }

        if (discriminator === 3) {
            if (data.length < 2) {
                this.log(LogLevel.WARN, '[Legacy Forge] RegistryData is too short');
                return;
            }

            const hasMore = data.readUInt8(1) !== 0;
            let registryName = '';
            try {
                const offset = { val: 2 };
                registryName = this.readString(data, offset);
            } catch {
                // Registry name is only used for logging; the boolean above is the important part.
            }
            this.log(LogLevel.DEBUG, `[Legacy Forge] RegistryData ${registryName ? `${registryName} ` : ''}${hasMore ? '(more)' : '(last)'}`);

            if (!hasMore && this.legacyForgeHandshakeState === 'waiting_server_complete') {
                this.legacyForgeHandshakeState = 'pending_complete';
                client.write('custom_payload', {
                    channel: LEGACY_FORGE_HANDSHAKE_CHANNEL,
                    data: this.createLegacyForgeAckPayload(3)
                });
                this.log(LogLevel.DEBUG, '[Legacy Forge] Registry data complete, acknowledging');
            }
            return;
        }

        if (discriminator === -1) {
            if (this.legacyForgeHandshakeState === 'pending_complete') {
                this.legacyForgeHandshakeState = 'complete';
                client.write('custom_payload', {
                    channel: LEGACY_FORGE_HANDSHAKE_CHANNEL,
                    data: this.createLegacyForgeAckPayload(4)
                });
                this.log(LogLevel.INFO, '[Legacy Forge] Server waiting for client completion, acknowledging');
            } else if (this.legacyForgeHandshakeState === 'complete') {
                client.write('custom_payload', {
                    channel: LEGACY_FORGE_HANDSHAKE_CHANNEL,
                    data: this.createLegacyForgeAckPayload(5)
                });
                this.log(LogLevel.INFO, '[Legacy Forge] Handshake complete');
            }
            return;
        }

        if (discriminator === -2) {
            this.legacyForgeHandshakeState = 'idle';
            this.log(LogLevel.WARN, '[Legacy Forge] Server reset handshake');
        }
    }

    // 采集接口（POST /capture/start）刷新缓存后调用：清空内存中的 probe 状态并尽快重连，
    // 让真实客户端刚采集到的最新频道声明立即生效（无需重启进程）。
    public reloadNeoForgeProbeCache() {
        this.neoForgeProbeCacheKey = null;
        this.neoForgeProbeCacheAddress = null;
        this.neoForgeProbeCacheProtocolVersion = null;
        this.neoForgeProbeCacheModLoader = null;
        this.neoForgeProbeChannels.clear();
        this.neoForgeAcceptedChannels.clear();
        this.neoForgeProbeDefaultsByNamespace.clear();
        this.lastNeoForgeFailureChannel = null;
        this.neoForgePlayCacheSaved = false;
        this.pendingNeoForgeProbeReconnect = false;
        this.log(LogLevel.INFO, '[Capture API] 已刷新 NeoForge 频道声明缓存，重连以使用最新声明');
        this.scheduleReconnect(1000);
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
        const legacyForge = this.isLegacyForge(resolvedVersion, status, modLoader);
        console.log(`Connection attempt: ${modLoader} (${resolvedVersion})`);
        this.legacyForgeHandshakeState = 'idle';
        this.legacyForgeServerMods = new Map(this.serverModVersions);
        this.loadNeoForgeProbeCache(resolvedVersion, modLoader, status.protocol);
        this.neoForgePlayCacheSaved = false;
        this.configureYggdrasilJoinThrottle(modLoader);

        // Legacy Forge (1.7-1.12.2) advertises FML; modern Forge uses FML3.
        const fmlMarker = legacyForge ? '\0FML\0' : '\0FML3\0';
        const serverHost = status.isForge ? `${this.host}${fmlMarker}` : this.host;

        // 真实服务端的 login 首包（ServerboundHelloPacket，NeoForge 日志里显示为
        // 'serverbound/minecraft:hello'）用 readUtf(16) 读取玩家名：名字超过 16 字符时服务端会直接抛
        // DecoderException 并断开（客户端只看到 "网络协议错误"）。minecraft-protocol 自带的服务端实现
        // 不做这个校验，所以本地自测发现不了，这里统一兜底截断。
        if (this.authType !== 'microsoft' && this.username.length > 16) {
            const truncated = this.username.slice(0, 16);
            this.log(LogLevel.WARN, `[Auth] 用户名 "${this.username}" 超过 16 字符上限，登录时将使用 "${truncated}"`);
            this.username = truncated;
        }

        const options: any = {
            host: this.host,
            port: this.port,
            // 正版登录固定使用初始用户名作为认证 cache key，避免登录后被改成正版 ID 时缓存失效
            username: this.authType === 'microsoft' ? this.authUsername : this.username,
            version: resolvedVersion,
            serverHost: this.host, // Use clean host initially
            // Minecraft 26.1 的 login_start 需要 playerUUID，而 minecraft-protocol 只在 offline/microsoft
            // 认证分支下准备 client.uuid；Mojang 账号认证早已下线，因此非正版登录一律走 offline 分支。
            auth: this.authType === 'microsoft' ? 'microsoft' : 'offline',
            // 库的 keepalive 插件只用 keep_alive 包刷新这个超时（原版客户端看任意数据包），
            // 默认 30 秒在网络抖动时容易误判，这里放宽到 60 秒并允许配置。
            checkTimeoutInterval: this.getKeepAliveTimeoutMs(),
            profilesFolder: './.minecraft_auth', // Enable built-in auth caching
            hideErrors: true, // Suppress packet parsing errors (e.g. declare_commands on modded servers)
            ...this.clientOptions
        };

        this.client = mc.createClient(options);

        // TCP 层加固：启用 SO_KEEPALIVE 让中间设备/系统尽早发现死连接，setNoDelay 减少小包延迟
        // （原版客户端由 Netty 默认启用，这里补齐，避免网络质量差时表现不如真实客户端）。
        try {
            const socket = (this.client as any)?.socket;
            if (socket?.setKeepAlive) socket.setKeepAlive(true, 15_000);
            if (socket?.setNoDelay) socket.setNoDelay(true);
        } catch (e) {
            this.log(LogLevel.DEBUG, `[Connection] socket 参数设置失败：${(e as Error).message}`);
        }

        this.startConnectionDiagnostics();

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

            this.sentPacketCount++;
            // 仅在 TRACE 级别才需要包大小（estimatePacketSize 会完整序列化一遍，属于昂贵操作）
            if (this.logLevel >= LogLevel.TRACE) {
                const outgoingSize = this.estimatePacketSize(String(packetName), params);
                if (packetName === 'custom_payload') {
                    this.traceCustomPayload('C->S', String(this.client?.state), params, outgoingSize);
                } else {
                    this.tracePacket('C->S', String(this.client?.state), String(packetName), outgoingSize);
                }
            }
            if (packetName === 'chat_command') {
                this.log(LogLevel.INFO, `[Command Packet] -> /${params?.command ?? ''}`);
            }
            return oldWrite.call(this.client, packetName, params);
        };

        this.client.on('packet', (data, meta, buffer?: Buffer, fullBuffer?: Buffer) => {
            this.receivedPacketCount++;
            this.lastPacketReceivedAt = Date.now();

            if (this.logLevel >= LogLevel.TRACE) {
                if (meta.name === 'custom_payload') {
                    this.traceCustomPayload('S->C', String(this.client?.state), data, fullBuffer?.length ?? buffer?.length);
                } else {
                    this.tracePacket('S->C', String(this.client?.state), String(meta.name), fullBuffer?.length ?? buffer?.length);
                }
            }

            // 上游 chat 插件在 finish_configuration（configuration 末尾）时才注册 declare_commands
            // 校验监听器，而 declare_commands 要到 play 阶段才下发；在这两个时机各检查一次即可（幂等）。
            if (meta.name === 'finish_configuration' || String(this.client?.state) === 'play') {
                this.disableUpstreamCommandTreeValidation();
            }

            // known packs 协商发生在 configuration 阶段，库的监听器在 login success 时就注册了；
            // 这里再兜一次（幂等），覆盖 play→configuration 重进的情况。
            if (String(this.client?.state) === 'configuration') {
                this.overrideSelectKnownPacks();
            }

            if ((meta.name === 'position' || meta.name === 'tags') && String(this.client?.state) === 'play') {
                this.markPlayReady();
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
                if (this.isChatValidationFailure((data as any)?.reason)) {
                    this.disableChatSending('服务端拒绝聊天/命令校验（multiplayer.disconnect.chat_validation_failed）；'
                        + '本端没有聊天签名密钥（minecraft-protocol 的客户端分支不设置 profileKeys），只能发送未签名命令');
                }
            }
            // play 状态下逐包日志：DEBUG 只打印包名（按秒限流），VERBOSE 才附带数据摘要，
            // 且只在数据包足够小的时候才做 JSON.stringify —— 大整合包每个包都序列化会阻塞事件循环，
            // 进而导致 keep_alive 处理延迟、被库判定超时而断线（表现为"网络差就掉线"）。
            if (this.logLevel >= LogLevel.DEBUG && !QUIET_PACKET_NAMES.has(meta.name)) {
                const now = Date.now();
                if (now - this.packetLogWindowStartedAt >= 1000) {
                    if (this.suppressedPacketLogs > 0) {
                        this.log(LogLevel.DEBUG, `[Packet] 上一条统计间隔内另有 ${this.suppressedPacketLogs} 条包日志被限流省略`);
                        this.suppressedPacketLogs = 0;
                    }
                    this.packetLogWindowStartedAt = now;
                    this.packetLogWindowCount = 0;
                }

                if (this.packetLogWindowCount < DEFAULT_PACKET_LOG_PER_SECOND) {
                    this.packetLogWindowCount++;
                    this.log(LogLevel.DEBUG, `Packet: ${meta.name}`);

                    if (this.logLevel >= LogLevel.VERBOSE) {
                        const packetSize = fullBuffer?.length ?? buffer?.length ?? 0;
                        if (packetSize <= PACKET_DATA_LOG_MAX_BYTES) {
                            try {
                                const dataStr = data ? JSON.stringify(data).slice(0, 150) : 'undefined';
                                this.log(LogLevel.VERBOSE, `Packet Data (${meta.name}): ${dataStr}`);
                            } catch (e) {
                                this.log(LogLevel.VERBOSE, `Packet Data (${meta.name}): [JSON Error]`);
                            }
                        } else {
                            this.log(LogLevel.VERBOSE, `Packet Data (${meta.name}): [${packetSize} bytes, 已跳过序列化]`);
                        }
                    }
                } else {
                    this.suppressedPacketLogs++;
                }
            }
        });

        this.client.on('custom_payload', (packet) => {
            const client = this.client;
            const channel = packet.channel;
            if (!client) return;

            if (legacyForge && String(client.state) === 'play' && channel === LEGACY_FORGE_HANDSHAKE_CHANNEL) {
                this.handleLegacyForgeHandshake(packet.data as Buffer | undefined);
                return;
            }

            if (String(client.state) !== 'configuration') return;

            if (channel === 'combat_roll:config_sync') {
                // Combat Roll（FTB Evolution 2 里的必需 mod）在 configuration 阶段做双向配置握手：
                // 服务器发 config_sync（JSON 配置），随后等待客户端的 combat_roll:ack —— 它是该阶段
                // 唯一的 required serverbound 频道，收不到就 30 秒超时断开连接。
                // 源码（ZsoltMolnarrr/CombatRoll, neoforge/.../NetworkEvents.java）里服务端 handler 为：
                //   if (payload.code().equals(ConfigurationTask.ID.toString())) finishCurrentTask(...)
                // 其中 ConfigurationTask.ID = combat_roll:config，因此 ack 的 payload 就是该字符串（writeUtf）。
                const buf = packet.data as Buffer | undefined;
                client.write('custom_payload', {
                    channel: 'combat_roll:ack',
                    data: this.writeString('combat_roll:config')
                });
                this.log(LogLevel.DEBUG, `[CombatRoll] Acknowledged config sync (${buf?.length ?? 0} bytes)`);
            } else if (channel === 'c:version') {                client.write('custom_payload', {
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
            } else if (channel === 'minecraft:register') {
                // 服务器刚声明了自己监听的通道（configuration 阶段开头）。
                // 真实 NeoForge 客户端会立刻回一份自己的监听列表；服务器的 hasChannel(c:version/c:register)
                // 是在收到 pong(0) 触发 runConfiguration() 时求值的，所以这里必须抢在 pong 之前发出，
                // 否则服务器不会注册 CommonVersion/CommonRegister 任务。
                this.sendNeoForgeConfigurationChannels(client);
            } else if (channel === 'neoforge:register') {
                const queryPayload = this.createNeoForgeModdedNetworkQueryPayload();
                client.write('custom_payload', {
                    channel: 'neoforge:register',
                    data: queryPayload
                });
                this.log(LogLevel.DEBUG, `[NeoForge] Sent ${this.getNeoForgeChannelDeclarations().length} configured modded channel declarations (${queryPayload.length} bytes)`);
            } else if (channel === 'neoforge:network') {
                const setupChannels = this.collectNeoForgeSetupChannels(packet.data as Buffer | undefined);
                const registeredChannels = Array.from(new Set([...this.getNeoForgeConfigurationChannels(), ...setupChannels]));
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

                const actionName = typeof action === 'string' ? action.toLowerCase() : '';
                if (actionName === 'remove_player') {
                    removePlayerByUuid(uuid, 'PlayerInfo Action: Remove Player');
                    continue;
                }

                let actionVal: number;
                if (typeof action === 'number') {
                    actionVal = action;
                } else if (typeof action === 'object' && action._value !== undefined) {
                    actionVal = action._value;
                } else if (actionName) {
                    switch (actionName) {
                        case 'add_player':
                            actionVal = 0x01;
                            break;
                        case 'update_latency':
                            actionVal = 0x10;
                            break;
                        case 'update_gamemode':
                        case 'update_display_name':
                            actionVal = 0;
                            break;
                        default:
                            actionVal = 0;
                    }
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
                const content = this.firstDefined(packet.content, packet.formattedMessage, packet.message);
                const text = this.extractCleanTextFromComponent(content);
                const suppressed = this.tryConsumeTpsCommandResponse(text);
                if (suppressed) {
                    this.log(LogLevel.DEBUG, `[TPS Fallback] Suppressed system chat response: ${text}`);
                    return;
                }
                this.log(LogLevel.INFO, `[Chat] (System) ${text}`);
                if (this.shouldEmitChatEvent('System', text)) {
                    this.emit('chat', { sender: 'System', message: text });
                }
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] system_chat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('systemChat', (packet: any) => {
            try {
                const content = this.firstDefined(packet.formattedMessage, packet.content, packet.message);
                const text = this.extractCleanTextFromComponent(content);
                const suppressed = this.tryConsumeTpsCommandResponse(text);
                if (suppressed) {
                    this.log(LogLevel.DEBUG, `[TPS Fallback] Suppressed systemChat response: ${text}`);
                    return;
                }
                this.log(LogLevel.INFO, `[Chat] (System) ${text}`);
                if (this.shouldEmitChatEvent('System', text)) {
                    this.emit('chat', { sender: 'System', message: text });
                }
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] systemChat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('player_chat', (packet) => {
            try {
                const name = this.resolvePlayerChatSender(packet);
                const cleanMsg = this.resolvePlayerChatMessage(packet);
                const suppressed = this.tryConsumeTpsCommandResponse(cleanMsg);
                if (suppressed) {
                    this.log(LogLevel.DEBUG, `[TPS Fallback] Suppressed player chat response: ${cleanMsg}`);
                    return;
                }
                this.log(LogLevel.INFO, `[Chat] <${name}> ${cleanMsg}`);
                if (this.shouldEmitChatEvent(name, cleanMsg)) {
                    this.emit('chat', { sender: name, message: cleanMsg });
                }
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] player_chat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('playerChat', (packet: any) => {
            try {
                const name = this.resolvePlayerChatSender(packet);
                const cleanMsg = this.resolvePlayerChatMessage(packet);
                const suppressed = this.tryConsumeTpsCommandResponse(cleanMsg);
                if (suppressed) {
                    this.log(LogLevel.DEBUG, `[TPS Fallback] Suppressed playerChat response: ${cleanMsg}`);
                    return;
                }
                this.log(LogLevel.INFO, `[Chat] <${name}> ${cleanMsg}`);
                if (this.shouldEmitChatEvent(name, cleanMsg)) {
                    this.emit('chat', { sender: name, message: cleanMsg });
                }
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] playerChat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('chat', (packet) => {
            try {
                const content = this.firstDefined(packet.message, packet.formattedMessage, packet.content);
                const text = this.extractCleanTextFromComponent(content);
                const suppressed = this.tryConsumeTpsCommandResponse(text);
                if (suppressed) {
                    this.log(LogLevel.DEBUG, `[TPS Fallback] Suppressed legacy chat response: ${text}`);
                    return;
                }
                this.log(LogLevel.INFO, `[Chat] ${text}`);
                if (this.shouldEmitChatEvent('System', text)) {
                    this.emit('chat', { sender: 'System', message: text });
                }
            } catch (e) {
                this.log(LogLevel.DEBUG, `[Chat] legacy chat parse error: ${(e as Error).message}`);
            }
        });

        this.client.on('end', (reason) => {
            const lastPacketAgo = this.lastPacketReceivedAt ? Date.now() - this.lastPacketReceivedAt : -1;
            const detail = lastPacketAgo >= 0
                ? `最后收包 ${lastPacketAgo}ms 前；本连接收包 ${this.receivedPacketCount} / 发包 ${this.sentPacketCount}；事件循环延迟峰值 ${this.eventLoopLagPeakMs}ms`
                : '本连接未收到任何数据包';
            this.log(LogLevel.INFO, `Disconnected: ${reason}（${detail}）`);

            if (/keepAlive|timed out/i.test(String(reason))) {
                this.log(LogLevel.WARN, `[Connection] 判定为心跳超时：${this.getKeepAliveTimeoutMs()}ms 内未收到 keep_alive 包。`
                    + '该计时器仅由 keep_alive 包刷新（原版客户端看任意数据包，容忍度更高），'
                    + '网络抖动明显时可调大 config.json 的 checkTimeoutInterval。');
            }

            if (this.isChatValidationFailure(reason)) {
                this.disableChatSending('服务端拒绝聊天/命令校验（multiplayer.disconnect.chat_validation_failed）');
            }

            this.stopConnectionDiagnostics();
            this.scheduleReconnect(DEFAULT_RECONNECT_DELAY_MS);
        });

        this.client.on('error', (err: any) => {
            // Non-fatal: packet deserialization errors should not trigger reconnect.
            // These include PartialReadError and "Deserialization error for play.toClient".
            if (err.partialReadError || (err.field && typeof err.field === 'string' && err.field.includes('toClient'))) {
                this.log(LogLevel.WARN, `Packet parse error (non-fatal): ${err.message}`);
                this.recoverDeserializerAfterParseError(err);
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
            this.disableUpstreamCommandTreeValidation();
            this.overrideSelectKnownPacks();
            this.emit('connected');
        });
    }

    // minecraft-protocol 1.68.0 的 client/chat.js 会对 `declare_commands` 做 validateCommandTree 校验，
    // 该实现不兼容 Minecraft 26.1（协议 775）实际下发的命令树，命中后会立刻
    // `client.end('impossibleCommandTree')` 并报 "Server sent an impossible command tree"，
    // 表现为进入世界后立刻断线并反复重连。
    // 本程序只读玩家列表/TPS、不发送签名聊天，不依赖命令树，因此移除库的校验监听器，
    // 只保留一条诊断日志。
    // 时机很讲究：chat 插件是在收到 finish_configuration 包时才注册这些监听器的
    // （minecraft-protocol/src/client/play.js 的 onLogin → signedChatPlugin），
    // 且 client 先 emit 具体包名再 emit 'packet'，所以这里要"每次都检查一遍"：
    // 只要发现除我们自己之外的 declare_commands 监听器（即库又注册了）就再移除一次。
    private disableUpstreamCommandTreeValidation() {
        const client = this.client as any;
        if (!client) return;

        const marker = '__mcplcCommandTreeWatcher';
        if (client[marker] && client.listenerCount('declare_commands') <= 1) return;

        client.removeAllListeners('declare_commands');
        client.on('declare_commands', (packet: any) => {
            const nodeCount = Array.isArray(packet?.nodes) ? packet.nodes.length : 0;
            this.log(LogLevel.DEBUG, `[Commands] Received command tree (${nodeCount} nodes, upstream tree validation disabled)`);
        });
        client[marker] = true;
    }

    // Minecraft 1.20.5+ 的 known packs 协商：服务端在 configuration 阶段下发它支持的
    // datapack/资源包列表（`select_known_packs`），客户端必须回复自己选择的那部分。
    // minecraft-protocol 的实现（src/client/play.js）固定回一个**空列表**，这对小型服务端没问题，
    // 但对带大量 mod 的服务端会被判为不兼容：服务端会直接关闭连接（客户端只看到 socketClosed，
    // 收不到任何 disconnect 原因）。真实整合包客户端会回它认识的那些 pack，这里按同样的思路
    // 把服务端下发的列表原样回显（等价于"全部接受"）。
    private overrideSelectKnownPacks() {
        const client = this.client as any;
        if (!client) return;

        const marker = '__mcplcKnownPacksWatcher';
        if (client[marker] && client.listenerCount('select_known_packs') <= 1) return;

        client.removeAllListeners('select_known_packs');
        client.on('select_known_packs', (packet: any) => {
            const packs = Array.isArray(packet?.packs) ? packet.packs : [];
            this.client?.write('select_known_packs', { packs });
            this.log(LogLevel.DEBUG, `[Config] Selected ${packs.length} known packs from the server list`);
        });
        client[marker] = true;
    }

    private recoverDeserializerAfterParseError(err: any) {
        const client = this.client as any;
        if (!client || this.deserializerResetPending) return;

        const field = typeof err?.field === 'string' ? err.field : '';
        if (!field.includes('toClient')) return;

        this.deserializerResetPending = true;
        setImmediate(() => {
            this.deserializerResetPending = false;
            if (this.client !== client || client.ended) return;

            try {
                const state = client.state;
                client.state = state;
                this.log(LogLevel.WARN, `[Packet] Recovered ${state}.toClient parser after deserialization error`);
            } catch (e) {
                this.log(LogLevel.WARN, `[Packet] Failed to recover parser: ${(e as Error).message}`);
            }
        });
    }

    private markPlayReady() {
        if (this.playReady) return;
        this.playReady = true;
        this.log(LogLevel.INFO, '[Connection] Play state is ready for commands');
        this.startTpsFallbackTimer();
    }

    private cleanup() {
        this.players.clear();
        this.playReady = false;
        this.stopTpsFallbackTimer();
        this.stopConnectionDiagnostics();
        this.tpsCommandPendingUntil = 0;
        this.tpsCommandCooldownUntil = 0;
        this.tpsCommandSuppressUntil = 0;
        this.deserializerResetPending = false;
        this.pendingTpsDimensionResult = null;
        if (this.client) {
            this.client.removeAllListeners();
            this.client = null;
        }
    }

    private getKeepAliveTimeoutMs(): number {
        const configured = Number(this.clientOptions?.checkTimeoutInterval);
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_KEEPALIVE_TIMEOUT_MS;
    }

    // 连接健康度统计：便于区分"真·网络断开"与"客户端自身阻塞导致的心跳超时"。
    // eventLoopLagPeakMs 高说明事件循环被卡住（例如日志/序列化过重），不是网络问题。
    private startConnectionDiagnostics() {
        this.stopConnectionDiagnostics();
        this.lastPacketReceivedAt = 0;
        this.receivedPacketCount = 0;
        this.sentPacketCount = 0;
        this.eventLoopLagPeakMs = 0;
        this.packetLogWindowStartedAt = Date.now();
        this.packetLogWindowCount = 0;
        this.suppressedPacketLogs = 0;

        let expected = Date.now() + 200;
        const lagTimer = setInterval(() => {
            const now = Date.now();
            const lag = Math.max(0, now - expected);
            if (lag > this.eventLoopLagPeakMs) this.eventLoopLagPeakMs = lag;
            expected = now + 200;
        }, 200);
        lagTimer.unref?.();
        this.eventLoopTimer = lagTimer;

        const statsTimer = setInterval(() => {
            const lastPacketAgo = this.lastPacketReceivedAt ? Date.now() - this.lastPacketReceivedAt : -1;
            this.log(LogLevel.DEBUG, `[Connection] 收包 ${this.receivedPacketCount} / 发包 ${this.sentPacketCount}`
                + `，事件循环延迟峰值 ${this.eventLoopLagPeakMs}ms`
                + `，距上次收包 ${lastPacketAgo < 0 ? 'n/a' : `${lastPacketAgo}ms`}`);
            this.eventLoopLagPeakMs = 0;
        }, DEFAULT_STATS_INTERVAL_MS);
        statsTimer.unref?.();
        this.statsTimer = statsTimer;
    }

    private stopConnectionDiagnostics() {
        if (this.eventLoopTimer) {
            clearInterval(this.eventLoopTimer);
            this.eventLoopTimer = null;
        }
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
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

        const command = String(this.clientOptions?.tpsFallbackCommand ?? (this.status.modLoader === 'forge' ? 'forge tps' : 'neoforge tps')).replace(/^\/+/, '');
        if (this.chatCommandDisabledReason) {
            // 服务器会因聊天/命令校验失败直接断开，继续发只会造成"被踢—重连"循环，因此只读 footer
            if (!this.chatCommandDisabledLogged) {
                this.chatCommandDisabledLogged = true;
                this.log(LogLevel.WARN, `[TPS Fallback] 已停用命令方式读取 TPS：${this.chatCommandDisabledReason}`
                    + '（TPS 将只依赖服务端下发的 playerlist header/footer；如需保留命令方式，请让服务端允许未签名命令或改用能签名的客户端实现）');
            }
            return;
        }
        try {
            this.log(LogLevel.DEBUG, `[TPS Fallback] No TPS update for ${idleMs === Infinity ? 'ever' : `${Math.round(idleMs / 1000)}s`}, requesting via /${command}`);
            this.sendCommand(command);
            const responseWindow = Number(this.clientOptions?.tpsFallbackResponseWindowMs ?? DEFAULT_TPS_FALLBACK_RESPONSE_WINDOW_MS);
            this.tpsCommandCooldownUntil = now + Math.max(cooldown, responseWindow);
        } catch (e) {
            this.log(LogLevel.WARN, `[TPS Fallback] Failed to send command: ${(e as Error).message}`);
            this.tpsCommandCooldownUntil = now + cooldown;
        }
    }

    private beginTpsCommandResponseWindow(command: string) {
        const normalized = command.replace(/^\/+/, '').trim().toLowerCase();
        if (!/^(?:neo)?forge\s+tps(?:\s|$)/.test(normalized)) return;

        const now = Date.now();
        const responseWindow = Number(this.clientOptions?.tpsFallbackResponseWindowMs ?? DEFAULT_TPS_FALLBACK_RESPONSE_WINDOW_MS);
        this.pendingTpsDimensionResult = null;
        this.tpsCommandPendingUntil = now + responseWindow;
        this.tpsCommandSuppressUntil = this.tpsCommandPendingUntil;
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
            const forgeSummaryAll = trimmed.match(/^commands\.forge\.tps\.summary\.all\s+([\d.]+)\s+([\d.]+)/i);
            if (forgeSummaryAll) {
                mspt = forgeSummaryAll[1];
                tps = forgeSummaryAll[2];
                isOverall = true;
            } else {
                const dimKey = trimmed.match(/^commands\.(?:neo)?forge\.tps\.dimension\s+\S+\s+([\d.]+)\s+([\d.]+)/i);
                if (dimKey) {
                    tps = dimKey[1];
                    mspt = dimKey[2];
                } else {
                    const forgeSummaryNamed = trimmed.match(/^commands\.forge\.tps\.summary\.named\s+\S+\s+\S+\s+([\d.]+)\s+([\d.]+)/i);
                    if (forgeSummaryNamed) {
                        mspt = forgeSummaryNamed[1];
                        tps = forgeSummaryNamed[2];
                    }
                }
            }
        }

        // Legacy 1.12.2 `/forge tps` raw translate keys:
        // commands.forge.tps.summary Overall 14.131 20.000
        // commands.forge.tps.summary Dim  0 (overworld) 0.126 20.000
        if (!tps) {
            const legacyOverall = trimmed.match(/^commands\.forge\.tps\.summary\s+Overall\s+([\d.]+)\s+([\d.]+)/i);
            if (legacyOverall) {
                mspt = legacyOverall[1];
                tps = legacyOverall[2];
                isOverall = true;
            } else {
                const legacyDim = trimmed.match(/^commands\.forge\.tps\.summary\s+Dim\s+\S+\s+\([^)]*\)\s+([\d.]+)\s+([\d.]+)/i);
                if (legacyDim) {
                    mspt = legacyDim[1];
                    tps = legacyDim[2];
                }
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

    // 服务端返回的断开原因里出现 chat_validation_failed 时，说明它拒绝我们的聊天/命令包。
    // 这种情况下继续发送只会每次都把连接搞断（表现为"断线重连"循环），因此置位禁用位。
    private isChatValidationFailure(reason: unknown): boolean {
        if (reason === undefined || reason === null) return false;
        let text: string;
        try {
            text = typeof reason === 'string' ? reason : JSON.stringify(reason);
        } catch {
            text = String(reason);
        }
        return /chat_validation_failed|chat_validation/i.test(text);
    }

    private disableChatSending(reason: string) {
        if (this.chatCommandDisabledReason) return;
        this.chatCommandDisabledReason = reason;
        this.log(LogLevel.WARN, `[Chat] ${reason}；本进程内不再发送聊天/命令，避免反复被服务端断开（玩家列表与 footer 里的 TPS 不受影响）`);
    }

    public sendChat(message: string): void {
        if (this.chatCommandDisabledReason) {
            throw new Error(`聊天/命令已停用：${this.chatCommandDisabledReason}`);
        }
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
        if (!this.playReady) {
            throw new Error('bot is not ready to send commands yet');
        }
        this.sendChat(`/${trimmed}`);
        this.beginTpsCommandResponseWindow(trimmed);
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
