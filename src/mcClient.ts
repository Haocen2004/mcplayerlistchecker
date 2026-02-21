import * as mc from 'minecraft-protocol';
import { EventEmitter } from 'events';

export enum LogLevel {
    SILENT = 0,
    ERR = 1,
    WARN = 2,
    INFO = 3,
    DEBUG = 4,
    VERBOSE = 5
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
    fmlVersion?: string;
    mods?: string[];
    tps?: string;
    mspt?: string;
}

export class MCClient extends EventEmitter {
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
    public clientOptions: any = {};

    constructor(host: string, port: number = 25565, username: string = 'PlayerListBot', logLevel: LogLevel = LogLevel.INFO, authType: 'microsoft' | 'mojang' = 'mojang') {
        super();
        this.host = host;
        this.port = port;
        this.username = username;
        this.logLevel = logLevel;
        this.authType = authType;
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

    private extractTextFromComponent(obj: any): string {
        if (!obj) return '';
        if (typeof obj === 'string') return obj;

        let text = obj.text || '';
        if (obj.extra && Array.isArray(obj.extra)) {
            for (const e of obj.extra) {
                text += this.extractTextFromComponent(e);
            }
        }
        if (obj.translate) {
            // Very basic translation support (just joining parts)
            text += obj.translate;
            if (obj.with && Array.isArray(obj.with)) {
                for (const w of obj.with) {
                    text += ' ' + this.extractTextFromComponent(w);
                }
            }
        }
        return text;
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

    private async ping(): Promise<ServerStatus> {
        return new Promise((resolve) => {
            mc.ping({ host: this.host, port: this.port }, (err, response: any) => {
                if (err) {
                    resolve({ online: false, playersOnline: 0, playersMax: 0, isForge: false });
                } else {
                    const res = response as any;
                    const isForge = !!(res.forgeData || (res.version && res.version.name && res.version.name.includes('Forge')));

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

                    resolve({
                        online: true,
                        version: res.version?.name,
                        protocol: res.version?.protocol,
                        motd: typeof res.description === 'string' ? res.description : (res.description?.text || ''),
                        playersOnline: res.players?.online,
                        playersMax: res.players?.max,
                        isForge,
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
        this.status = status;

        if (!status.online) {
            console.log('Server is offline, waiting 10s...');
            this.reconnectTimeout = setTimeout(() => this.connect(), 10000);
            return;
        }

        console.log(`Connection attempt: ${status.isForge ? 'Forge (Handshake Tagging)' : 'Vanilla'}`);

        // FML3 Marker for 1.20.1+
        const fmlMarker = '\0FML3\0';
        const serverHost = status.isForge ? `${this.host}${fmlMarker}` : this.host;

        const options: any = {
            host: this.host,
            port: this.port,
            username: this.username,
            version: status.version || '1.20.1',
            serverHost: this.host, // Use clean host initially
            auth: this.authType,
            profilesFolder: './.minecraft_auth', // Enable built-in auth caching
            ...this.clientOptions
        };

        this.client = mc.createClient(options);

        // CORE FIX: Intercept outgoing packets
        const oldWrite = this.client.write;
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
                    console.log(`[Plugin] Blocking auto-response for ID ${params.messageId}`);
                    return; // DO NOT SEND
                }
                const dataHex = params.data.toString('hex').slice(0, 32);
                console.log(`[Plugin] Sending wrapped response ID ${params.messageId}, length: ${params.data.length}, data: ${dataHex}...`);
            }

            return oldWrite.call(this.client, packetName, params);
        };

        this.client.on('packet', (data, meta) => {
            if (meta.name === 'disconnect' || meta.name === 'kick_disconnect') {
                this.log(LogLevel.ERR, `Disconnected: ${JSON.stringify(data)}`);
            }
            // Safe debug logging for play state to catch player disconnects
            const noise = ['keep_alive', 'update_time', 'rel_entity_move', 'entity_metadata', 'map_chunk', 'custom_payload', 'world_event', 'sound_effect', 'entity_teleport', 'entity_velocity'];
            if (this.client?.state === 'play' && !noise.includes(meta.name)) {
                this.log(LogLevel.DEBUG, `Packet: ${meta.name}`);
                try {
                    const dataStr = data ? JSON.stringify(data).slice(0, 150) : 'undefined';
                    this.log(LogLevel.VERBOSE, `Packet Data (${meta.name}): ${dataStr}`);
                } catch (e) {
                    this.log(LogLevel.VERBOSE, `Packet Data (${meta.name}): [JSON Error]`);
                }
            }
        });

        this.client.on('login_plugin_request', (packet) => {
            console.log(`[Plugin] Request: ${packet.channel} (ID: ${packet.messageId})`);

            if (packet.channel === 'fml:login_wrapper' || packet.channel === 'fml:loginwrapper') {
                const buf = packet.data as Buffer;
                if (!buf || buf.length === 0) return;

                const offset = { val: 0 };
                const fmlChannel = this.readString(buf, offset);
                const innerLen = this.readVarInt(buf, offset); // Inner packet length
                const packetID = this.readVarInt(buf, offset);

                console.log(`[Plugin] FML Channel: ${fmlChannel}, PacketID: ${packetID}`);

                if (fmlChannel === 'fml:handshake') {
                    let wrappedPayload: Buffer | null = null;

                    if (packetID === 1) { // S2CModList (FML3/FML2)
                        try {
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

                            wrappedPayload = Buffer.concat([
                                this.writeString('fml:handshake'),
                                this.writeVarInt(reply.length),
                                reply
                            ]);
                        } catch (e) {
                            console.error('[Handshake] Error parsing ModList:', e);
                        }
                    } else {
                        // All other FML packets (RegistryData, Config, S2CModData) -> ACK (99)
                        const ack = this.writeVarInt(99);
                        wrappedPayload = Buffer.concat([
                            this.writeString('fml:handshake'),
                            this.writeVarInt(ack.length),
                            ack
                        ]);
                        this.log(LogLevel.DEBUG, `[Handshake] Sending ACK (99) for PacketID: ${packetID}`);
                    }

                    if (wrappedPayload) {
                        this.client?.write('login_plugin_response', {
                            messageId: packet.messageId,
                            data: wrappedPayload
                        });
                    }
                }
            } else {
                // Fallback for other plugin channels (usually just empty response)
                this.client?.write('login_plugin_response', {
                    messageId: packet.messageId,
                    data: Buffer.alloc(0)
                });
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
                this.log(LogLevel.INFO, `Player Left: ${player.username} (${targetUuid}) [via ${source}]`);
                // Import locally to avoid top-level issues if index.ts hasn't initialized DB
                if (player.username !== this.username) {
                    import('./db').then(db => db.saveLog({ type: 'leave', uuid: targetUuid, username: player!.username, server: this.host }));
                }
            } else {
                this.log(LogLevel.DEBUG, `Remove requested for unknown UUID (${source}): ${uuid}`);
            }
        };

        const handlePlayerInfo = (packet: any, meta: any) => {
            const { action, data } = packet;
            // console.log("handlePlayerInfo:", meta.name);
            // const isModern = meta.name === 'player_info_update';

            for (const item of data) {
                const uuid = item.uuid || item.UUID;
                if (!uuid) continue;

                let actionVal: number;
                if (typeof action === 'number') {
                    actionVal = action;
                } else if (typeof action === 'object' && action._value !== undefined) {
                    actionVal = action._value;
                } else {
                    // Fallback or legacy handling
                    actionVal = action.add_player ? 0 : -1;
                }

                // if (isModern) {
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
                        player.latency = latency || 0;
                        this.log(LogLevel.DEBUG, `Player Latency Updated: ${player.username} (${latency}ms)`);
                    }
                }

                // Note: 0x40 is Priority, NOT Remove. Removal is handled by player_info_remove.
                // } else {
                //     // Legacy player_info (pre-1.19.3)
                //     if (actionVal === 0) { // Add Player
                //         const username = item.player?.name || item.name;
                //         const latency = item.latency ?? item.ping;
                //         if (username) {
                //             const player: Player = { uuid, username, latency: latency || 0 };
                //             if (!this.players.has(uuid)) {
                //                 this.players.set(uuid, player);
                //                 this.uuidToName.set(uuid, username);
                //                 this.emit('playerJoin', player);
                //                 this.log(LogLevel.INFO, `Player Joined: ${username} (${uuid})`);
                //                 if (username !== this.username) {
                //                     import('./db').then(db => db.saveLog({ type: 'join', uuid, username, server: this.host }));
                //                 }
                //             }
                //         }
                //     } else if (actionVal === 2) { // Update Latency
                //         const latency = item.latency ?? item.ping;
                //         const player = this.players.get(uuid);
                //         if (player) {
                //             player.latency = latency || 0;
                //         }
                //     } else if (actionVal === 4) { // Remove Player
                //         removePlayerByUuid(uuid, 'Action');
                //     }
                // }
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

        // 1.20.1 Forge specific packet for removal
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
                    const footerObj = typeof packet.footer === 'string' ? JSON.parse(packet.footer) : packet.footer;
                    const textContent = this.extractTextFromComponent(footerObj).replace(/§[0-9a-fk-or]/g, '');
                    this.log(LogLevel.DEBUG, `Flattened Footer: ${textContent}`);

                    const tpsMatch = textContent.match(/TPS[:\s]*([\d.]+)/i);
                    const msptMatch = textContent.match(/MSPT[:\s]*([\d.]+)/i);

                    if (tpsMatch) this.status.tps = tpsMatch[1];
                    if (msptMatch) this.status.mspt = msptMatch[1];

                    if (tpsMatch || msptMatch) {
                        this.log(LogLevel.DEBUG, `Extracted from footer - TPS: ${this.status.tps}, MSPT: ${this.status.mspt}`);
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

        // Chat parsing for 1.20.1 (Modern and Legacy)
        this.client.on('system_chat', (packet) => {
            try {
                const content = typeof packet.content === 'string' ? JSON.parse(packet.content) : packet.content;
                const text = this.extractTextFromComponent(content).replace(/§[0-9a-fk-or]/g, '');
                this.log(LogLevel.INFO, `[Chat] (System) ${text}`);
                this.emit('chat', { sender: 'System', message: text });
            } catch (e) { }
        });

        this.client.on('player_chat', (packet) => {
            try {
                const senderUuid = packet.senderUuid;
                const senderNameComp = packet.senderName ? (typeof packet.senderName === 'string' ? JSON.parse(packet.senderName) : packet.senderName) : null;

                let name = 'Unknown';
                if (senderNameComp) {
                    name = this.extractTextFromComponent(senderNameComp).replace(/§[0-9a-fk-or]/g, '');
                } else if (senderUuid && this.uuidToName.has(senderUuid)) {
                    name = this.uuidToName.get(senderUuid)!;
                }

                let message = packet.unsignedContent ? this.extractTextFromComponent(typeof packet.unsignedContent === 'string' ? JSON.parse(packet.unsignedContent) : packet.unsignedContent) : packet.plainMessage;
                const cleanMsg = message.replace(/§[0-9a-fk-or]/g, '');
                this.log(LogLevel.INFO, `[Chat] <${name}> ${cleanMsg}`);
                this.emit('chat', { sender: name, message: cleanMsg });
            } catch (e) { }
        });

        this.client.on('chat', (packet) => {
            try {
                const message = typeof packet.message === 'string' ? JSON.parse(packet.message) : packet.message;
                const text = this.extractTextFromComponent(message).replace(/§[0-9a-fk-or]/g, '');
                this.log(LogLevel.INFO, `[Chat] ${text}`);
                this.emit('chat', { sender: 'System', message: text });
            } catch (e) { }
        });

        this.client.on('end', (reason) => {
            this.log(LogLevel.INFO, `Disconnected: ${reason}`);
            this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
        });

        this.client.on('error', (err) => {
            this.log(LogLevel.ERR, `Client Error: ${err.message}`);
            this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
        });

        this.client.on('success', () => {
            this.log(LogLevel.INFO, 'Logged in to Forge server!');
            if (this.client) {
                this.username = this.client.username;
                this.log(LogLevel.INFO, `Username updated to: ${this.username}`);
            }
            this.emit('connected');
        });
    }

    private cleanup() {
        this.players.clear();
        if (this.client) {
            this.client.removeAllListeners();
            this.client = null;
        }
    }

    public getPlayers(): Player[] {
        return Array.from(this.players.values());
    }

    public getStatus(): ServerStatus {
        return this.status;
    }
}
