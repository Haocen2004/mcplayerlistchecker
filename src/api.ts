import express from 'express';
import { Server } from 'ws';
import { createServer } from 'http';
import { MCClient, Player } from './mcClient';

export function startApiServer(mcClient: MCClient, port: number = 3000) {
    const app = express();
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
