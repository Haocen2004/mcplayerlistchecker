import express from 'express';
import { Server } from 'ws';
import { createServer } from 'http';
import { MCClient, Player } from './mcClient';

class ApiError extends Error {
    constructor(public statusCode: number, message: string) {
        super(message);
    }
}

export function startApiServer(mcClient: MCClient, port: number = 3000) {
    const app = express();
    app.use(express.json({ limit: '16kb' }));
    const server = createServer(app);
    const wss = new Server({ server });

    const getPublicStatus = () => {
        const status: any = { ...mcClient.getStatus() };
        delete status.mods;
        return status;
    };

    const getPublicPlayers = () => {
        const allPlayers = mcClient.getPlayers();
        return allPlayers.filter(p => p.username !== (mcClient as any).username);
    };

    const getPlayersPayload = () => ({
        status: getPublicStatus(),
        players: getPublicPlayers()
    });

    const sendChat = (body: any) => {
        const message = typeof body?.message === 'string' ? body.message : '';
        if (!message) throw new ApiError(400, 'message must be a non-empty string');
        if (message.startsWith('/')) throw new ApiError(400, 'use /command endpoint to send commands');
        mcClient.sendChat(message);
        return { ok: true };
    };

    const sendCommand = (body: any) => {
        const command = typeof body?.command === 'string' ? body.command : '';
        if (!command) throw new ApiError(400, 'command must be a non-empty string');
        mcClient.sendCommand(command);
        return { ok: true };
    };

    const toHttpError = (e: unknown) => {
        if (e instanceof ApiError) return { status: e.statusCode, error: e.message };
        return { status: 503, error: (e as Error).message };
    };

    app.get('/players', (_req, res) => {
        res.json(getPlayersPayload());
    });

    app.get('/status', (_req, res) => {
        res.json(getPublicStatus());
    });

    app.post('/chat', (req, res) => {
        try {
            res.json(sendChat(req.body));
        } catch (e) {
            const { status, error } = toHttpError(e);
            res.status(status).json({ ok: false, error });
        }
    });

    app.post('/command', (req, res) => {
        try {
            res.json(sendCommand(req.body));
        } catch (e) {
            const { status, error } = toHttpError(e);
            res.status(status).json({ ok: false, error });
        }
    });

    wss.on('connection', (ws) => {
        console.log('New WS client connected');

        const sendState = (requestId?: any) => {
            ws.send(JSON.stringify({
                type: 'init',
                requestId,
                ...getPlayersPayload()
            }));
        };

        // Send current status and player list on connection
        sendState();

        // Keep WS commands aligned with HTTP endpoints. Backward compatibility:
        // a non-JSON/unknown message still refreshes the current state.
        ws.on('message', (raw) => {
            const request = parseWsRequest(raw);
            const requestId = request?.requestId ?? request?.id;
            try {
                const route = resolveWsRoute(request);
                switch (route.path) {
                    case '/players':
                        ws.send(JSON.stringify({
                            type: 'players',
                            requestId,
                            ...getPlayersPayload()
                        }));
                        break;
                    case '/status':
                        ws.send(JSON.stringify({
                            type: 'status',
                            requestId,
                            data: getPublicStatus()
                        }));
                        break;
                    case '/chat':
                        ws.send(JSON.stringify({
                            type: 'chatResult',
                            requestId,
                            ...sendChat(route.body)
                        }));
                        break;
                    case '/command':
                        ws.send(JSON.stringify({
                            type: 'commandResult',
                            requestId,
                            ...sendCommand(route.body)
                        }));
                        break;
                    default:
                        sendState(requestId);
                }
            } catch (e) {
                const { status, error } = toHttpError(e);
                ws.send(JSON.stringify({
                    type: 'error',
                    requestId,
                    ok: false,
                    status,
                    error
                }));
            }
        });

        ws.on('close', () => console.log('WS client disconnected'));
    });

    // Broadcast mcClient events to WS clients
    mcClient.on('playerJoin', (player: Player) => {
        broadcast({ type: 'join', data: player });
    });

    mcClient.on('playerLeave', (player: Player) => {
        broadcast({ type: 'leave', data: player });
    });

    mcClient.on('playerUpdate', (player: Player) => {
        broadcast({ type: 'update', data: player });
    });

    mcClient.on('statusUpdate', () => {
        broadcast({ type: 'status', data: getPublicStatus() });
    });

    mcClient.on('chat', (chatData) => {
        broadcast({ type: 'chat', data: chatData });
    });

    function broadcast(msgObj: any) {
        const msg = JSON.stringify(msgObj);
        wss.clients.forEach(client => {
            if (client.readyState === client.OPEN) client.send(msg);
        });
    }

    server.listen(port, () => {
        console.log(`API Server listening on http://localhost:${port}`);
    });
}

function parseWsRequest(raw: any): any {
    const text = wsDataToString(raw).trim();
    if (!text) return { path: '/players' };
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function wsDataToString(data: any): string {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    return String(data ?? '');
}

function resolveWsRoute(request: any): { path: string; body: any } {
    if (typeof request === 'string') {
        const path = normalizeWsPath(request);
        return { path: path || '/players', body: {} };
    }

    if (!request || typeof request !== 'object') {
        return { path: '/players', body: {} };
    }

    const rawPath = request.path ?? request.endpoint ?? request.url ?? request.route ?? request.type ?? request.action;
    const path = normalizeWsPath(rawPath);
    const body = request.body ?? request.data ?? request;

    return { path: path || '/players', body };
}

function normalizeWsPath(value: any): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().replace(/^get:/, '').replace(/^post:/, '');
    const withoutApiPrefix = normalized.startsWith('/api/') ? normalized.slice(4) : normalized;

    switch (withoutApiPrefix) {
        case 'players':
        case '/players':
        case 'refresh':
        case '/refresh':
        case 'init':
        case 'state':
            return '/players';
        case 'status':
        case '/status':
            return '/status';
        case 'chat':
        case '/chat':
        case 'sendchat':
        case 'send_chat':
            return '/chat';
        case 'command':
        case '/command':
        case 'cmd':
        case '/cmd':
        case 'sendcommand':
        case 'send_command':
            return '/command';
        default:
            return null;
    }
}
