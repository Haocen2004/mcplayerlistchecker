import express from 'express';
import { Server } from 'ws';
import { createServer } from 'http';
import { MCClient, Player } from './mcClient';

export function startApiServer(mcClient: MCClient, port: number = 3000) {
    const app = express();
    app.use(express.json({ limit: '16kb' }));
    const server = createServer(app);
    const wss = new Server({ server });

    app.get('/players', (req, res) => {
        const allPlayers = mcClient.getPlayers();
        const filteredPlayers = allPlayers.filter(p => p.username !== (mcClient as any).username);
        const status: any = { ...mcClient.getStatus() };
        delete status.mods;

        res.json({
            status,
            players: filteredPlayers
        });
    });

    app.get('/status', (req, res) => {
        const status: any = { ...mcClient.getStatus() };
        delete status.mods;
        res.json(status);
    });

    app.post('/chat', (req, res) => {
        const message = typeof req.body?.message === 'string' ? req.body.message : '';
        if (!message) {
            return res.status(400).json({ ok: false, error: 'message must be a non-empty string' });
        }
        if (message.startsWith('/')) {
            return res.status(400).json({ ok: false, error: 'use /command endpoint to send commands' });
        }
        try {
            mcClient.sendChat(message);
            res.json({ ok: true });
        } catch (e) {
            res.status(503).json({ ok: false, error: (e as Error).message });
        }
    });

    app.post('/command', (req, res) => {
        const command = typeof req.body?.command === 'string' ? req.body.command : '';
        if (!command) {
            return res.status(400).json({ ok: false, error: 'command must be a non-empty string' });
        }
        try {
            mcClient.sendCommand(command);
            res.json({ ok: true });
        } catch (e) {
            res.status(503).json({ ok: false, error: (e as Error).message });
        }
    });

    wss.on('connection', (ws) => {
        console.log('New WS client connected');

        const sendState = () => {
            const status: any = { ...mcClient.getStatus() };
            delete status.mods;
            const filteredPlayers = mcClient.getPlayers().filter(p => p.username !== (mcClient as any).username);

            ws.send(JSON.stringify({
                type: 'init',
                status,
                players: filteredPlayers
            }));
        };

        // Send current status and player list on connection
        sendState();

        // Refresh player list on any message
        ws.on('message', () => {
            sendState();
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

    mcClient.on('statusUpdate', (status) => {
        broadcast({ type: 'status', data: status });
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
