# MC Player List Checker API Documentation

The Minecraft Player List Checker provides both HTTP REST endpoints and a WebSocket interface for real-time updates.

## Base URL
`http://localhost:3000` (Default port)

---

## HTTP Endpoints

### 1. Get Players List
**Endpoint:** `GET /players`

Returns the current server status and the list of online players.

**Response:**
```json
{
  "status": {
    "online": true,
    "version": "1.20.1",
    "protocol": 763,
    "motd": "A Minecraft Server",
    "playersOnline": 5,
    "playersMax": 20,
    "isForge": true,
    "fmlVersion": "FML3",
    "tps": "20.0",
    "mspt": "15.5"
    // Note: 'mods' list is excluded from this response for short response
  },
  "players": [
    {
      "uuid": "player-uuid-1",
      "username": "PlayerOne",
      "latency": 50
    },
    ...
  ]
}
```

### 2. Get Server Status
**Endpoint:** `GET /status`

Returns only the current server status information.

**Response:**
```json
{
  "online": true,
  "version": "1.20.1",
  ...
  "tps": "20.0",
  "mspt": "15.5"
}
```

---

## WebSocket Interface

**URL:** `ws://localhost:3000`

Connect to the WebSocket to receive live updates about player joins, leaves, and server status changes.

### Incoming Messages (Client -> Server)

**Refresh Request**
Send **any message** to the WebSocket server to request an immediate refresh of the current player list and status.

### Outgoing Messages (Server -> Client)

**1. Initialization / Refresh Response**
Sent immediately upon connection or in response to a refresh request.
```json
{
  "type": "init",
  "status": { ... },
  "players": [ ... ]
}
```

**2. Player Join Event**
Sent when a player joins the server.
```json
{
  "type": "join",
  "data": {
    "uuid": "...",
    "username": "...",
    "latency": 0
  }
}
```

**3. Player Leave Event**
Sent when a player leaves the server.
```json
{
  "type": "leave",
  "data": {
    "uuid": "...",
    "username": "...",
    "latency": 0
  }
}
```

**4. Player Update Event**
Sent when a player's information (e.g., latency) is updated.
```json
{
  "type": "update",
  "data": { ... }
}
```

**5. Status Update Event**
Sent when server status (e.g., TPS/MSPT) changes.
```json
{
  "type": "status",
  "data": { ... }
}
```

**6. Chat Message Event**
Sent when a chat or system message is received.
```json
{
  "type": "chat",
  "data": {
    "sender": "PlayerName", // 或 "System"
    "message": "Hello world!"
  }
}
```
