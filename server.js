const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const wss = new WebSocket.Server({ port: 8080 });

const connectedPlayers = new Map(); // username -> { ws, mapId, x, y, direction, partyId, guildId }
const playerDataPath = path.join(__dirname, 'playerData');
const accountsPath = path.join(__dirname, 'accounts.json');

// --- File System Setup ---
if (!fs.existsSync(playerDataPath)) fs.mkdirSync(playerDataPath);
if (!fs.existsSync(accountsPath)) fs.writeFileSync(accountsPath, JSON.stringify({}));

// --- Data Management Functions ---
function getAccounts() {
    try {
        return JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveAccounts(accounts) {
    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
}

function savePlayerData(username, data) {
    fs.writeFileSync(path.join(playerDataPath, `${username}.json`), JSON.stringify(data, null, 2));
}

function loadPlayerData(username) {
    const playerFile = path.join(playerDataPath, `${username}.json`);
    if (fs.existsSync(playerFile)) {
        return JSON.parse(fs.readFileSync(playerFile, 'utf8'));
    }
    return null; // Return null if file doesn't exist
}

// --- WebSocket Handlers ---
wss.on('connection', ws => {
    let username = null;
    ws.isAuthed = false;
    console.log('Client connected');

    // Set a timeout for unauthenticated connections
    const authTimeout = setTimeout(() => {
        if (!ws.isAuthed) {
            console.log('Client unauthenticated disconnected');
            ws.close();
        }
    }, 5000); // 5 seconds to authenticate

    ws.on('message', message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid message format:', message);
            return;
        }

        // --- Ping/Pong for connection status ---
        if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
            return;
        }

        // --- Login/Account Creation ---
        if (data.type === 'login' || data.type === 'createAccount') {
            const { username: user, password } = data;
            const accounts = getAccounts();
            
            if (data.type === 'createAccount') {
                if (accounts[user]) {
                    return ws.send(JSON.stringify({ type: 'createAccountResponse', success: false, error: 'Username already exists' }));
                }
                accounts[user] = { password };
                saveAccounts(accounts);
                savePlayerData(user, { mapId: 1, x: 8, y: 6 }); // Default starting position
                username = user;
                connectedPlayers.set(username, { ws, ...loadPlayerData(username) });
                ws.isAuthed = true;
                clearTimeout(authTimeout);
                ws.send(JSON.stringify({ type: 'createAccountResponse', success: true }));
            } else if (data.type === 'login') {
                if (accounts[user] && accounts[user].password === password) {
                    if (connectedPlayers.has(user)) {
                        return ws.send(JSON.stringify({ type: 'loginResponse', success: false, error: 'User is already logged in' }));
                    }
                    username = user;
                    const playerData = loadPlayerData(username) || { mapId: 1, x: 8, y: 6 };
                    connectedPlayers.set(username, { ws, ...playerData });
                    ws.isAuthed = true;
                    clearTimeout(authTimeout);
                    ws.send(JSON.stringify({ type: 'loginResponse', success: true }));
                } else {
                    return ws.send(JSON.stringify({ type: 'loginResponse', success: false, error: 'Invalid username or password' }));
                }
            }
            return;
        }
        
        // --- Requires Authentication ---
        if (!username) {
            return ws.send(JSON.stringify({ type: 'error', message: 'You must be logged in.' }));
        }

        // --- Player Data & Game State ---
        if (data.type === 'loadData') {
            const playerData = loadPlayerData(username);
            if (playerData) {
                // Update connectedPlayers with full data
                connectedPlayers.set(username, { ws, ...playerData });
                ws.send(JSON.stringify({ type: 'loadDataResponse', success: true, data: playerData }));
                
                // Now that we know their mapId, broadcast their presence and send them a list of other players
                broadcastToMap(playerData.mapId, {
                    type: 'playerJoin',
                    username,
                    mapId: playerData.mapId,
                    x: playerData.x,
                    y: playerData.y,
                    direction: playerData.direction
                }, username);
                
                const otherPlayersOnMap = Array.from(connectedPlayers.values())
                    .filter(p => p.mapId === playerData.mapId && p.username !== username)
                    .map(p => ({
                        username: p.username,
                        mapId: p.mapId,
                        x: p.x,
                        y: p.y,
                        direction: p.direction
                    }));
                ws.send(JSON.stringify({ type: 'playerList', players: otherPlayersOnMap }));
            } else {
                ws.send(JSON.stringify({ type: 'loadDataResponse', success: false, error: 'No player data found.' }));
            }
            return;
        }

        if (data.type === 'saveData') {
            const player = connectedPlayers.get(username);
            if (player) {
                savePlayerData(username, data.playerData);
            }
            return;
        }
        
        if (data.type === 'playerMove') {
            const player = connectedPlayers.get(username);
            if (player && data.mapId === player.mapId) {
                player.x = data.x;
                player.y = data.y;
                player.direction = data.direction;
                
                // Broadcast movement to all other players on the same map
                broadcastToMap(player.mapId, {
                    type: 'playerMove',
                    username,
                    x: player.x,
                    y: player.y,
                    direction: player.direction
                }, username);
            }
            return;
        }

        // --- Chat System ---
        if (data.type === 'chat') {
            const { scope, message, targetId } = data;
            if (scope === 'global') {
                broadcastToAll({ type: 'chat', scope, username, message });
            } else if (scope === 'party' && targetId) {
                broadcastToParty(targetId, { type: 'chat', scope, username, message });
            } else if (scope === 'guild' && targetId) {
                broadcastToGuild(targetId, { type: 'chat', scope, username, message });
            }
            return;
        }
        
        // --- Party System ---
        if (data.type === 'partyInvite') { /* ... party logic ... */ }
        if (data.type === 'partyAccept') { /* ... party logic ... */ }
        if (data.type === 'partyLeave') { /* ... party logic ... */ }
        
        // --- Guild System ---
        if (data.type === 'guildCreate') { /* ... guild logic ... */ }
        if (data.type === 'guildInvite') { /* ... guild logic ... */ }
        if (data.type === 'guildAccept') { /* ... guild logic ... */ }
        if (data.type === 'guildLeave') { /* ... guild logic ... */ }
    });

    ws.on('close', () => {
        clearTimeout(authTimeout);
        if (username) {
            const player = connectedPlayers.get(username);
            if (player) {
                savePlayerData(username, player); // Save data on disconnect
                connectedPlayers.delete(username);
                // Broadcast that the player has left
                broadcastToMap(player.mapId, { type: 'playerLeave', username: username }, username);
            }
            console.log(`Client ${username} disconnected`);
        } else {
            console.log('Client unauthenticated disconnected');
        }
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error);
    });
});

// --- Broadcast Helper Functions ---
function broadcastToMap(mapId, message, senderUsername = null) {
    const msg = JSON.stringify(message);
    for (const player of connectedPlayers.values()) {
        if (player.mapId === mapId && player.username !== senderUsername) {
            if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(msg);
            }
        }
    }
}

function broadcastToAll(message) {
    const msg = JSON.stringify(message);
    for (const player of connectedPlayers.values()) {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(msg);
        }
    }
}

function broadcastToParty(partyId, message) {
    const msg = JSON.stringify(message);
    for (const player of connectedPlayers.values()) {
        if (player.partyId === partyId) {
            if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(msg);
            }
        }
    }
}

function broadcastToGuild(guildId, message) {
    const msg = JSON.stringify(message);
    for (const player of connectedPlayers.values()) {
        if (player.guildId === guildId) {
            if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(msg);
            }
        }
    }
}

console.log('WebSocket server started on port 8080');
