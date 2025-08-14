// server.js
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const PLAYER_FOLDER = path.join(__dirname, 'PlayerAccounts');
const GLOBAL_LOG = path.join(__dirname, 'server_log.txt');

// Ensure Player Accounts folder exists
if (!fs.existsSync(PLAYER_FOLDER)) fs.mkdirSync(PLAYER_FOLDER);

// Track connected players: { username: { ws, mapId, x, y, direction, partyId, guildId } }
const connectedPlayers = new Map();

// Track parties: { partyId: { leader: username, members: [username] } }
const parties = new Map();
let nextPartyId = 1;

// Track guilds: { guildId: { name, leader: username, members: [username] } }
const guilds = new Map();
let nextGuildId = 1;

// Load guilds from disk (if any)
const GUILD_FILE = path.join(__dirname, 'guilds.json');
if (fs.existsSync(GUILD_FILE)) {
    const guildData = JSON.parse(fs.readFileSync(GUILD_FILE));
    Object.entries(guildData).forEach(([id, guild]) => guilds.set(Number(id), guild));
}

// Logging
function logGlobal(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
    fs.appendFileSync(GLOBAL_LOG, `[${ts}] ${msg}\n`);
}

function logPlayer(username, msg) {
    const playerDir = path.join(PLAYER_FOLDER, username);
    if (!fs.existsSync(playerDir)) fs.mkdirSync(playerDir);
    const logFile = path.join(playerDir, 'log.txt');
    const ts = new Date().toISOString();
    fs.appendFileSync(logFile, `[${ts}] ${msg}\n`);
}

// Load / Save player data
function loadPlayerData(username) {
    const dataFile = path.join(PLAYER_FOLDER, username, 'data.json');
    if (fs.existsSync(dataFile)) {
        return JSON.parse(fs.readFileSync(dataFile));
    }
    return null;
}

function savePlayerData(username, data) {
    const playerDir = path.join(PLAYER_FOLDER, username);
    if (!fs.existsSync(playerDir)) fs.mkdirSync(playerDir);
    fs.writeFileSync(path.join(playerDir, 'data.json'), JSON.stringify(data, null, 2));
}

// Save guilds to disk
function saveGuilds() {
    fs.writeFileSync(GUILD_FILE, JSON.stringify(Object.fromEntries(guilds), null, 2));
}

// Broadcast to players on the same map
function broadcastToMap(mapId, message, excludeUsername = null) {
    for (const [username, player] of connectedPlayers) {
        if (player.mapId === mapId && username !== excludeUsername && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    }
}

// Broadcast to party members
function broadcastToParty(partyId, message, excludeUsername = null) {
    const party = parties.get(partyId);
    if (!party) return;
    for (const member of party.members) {
        if (member !== excludeUsername) {
            const player = connectedPlayers.get(member);
            if (player && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify(message));
            }
        }
    }
}

// HTTP server for WebSocket upgrade
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logGlobal(`Client connected: ${ip}`);

    let username = null; // Track logged-in user

    ws.on('message', (msg) => {
        let data;
        try { data = JSON.parse(msg); } catch { return; }

        // Ping/Pong
        if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
            return;
        }

        // Account creation
        if (data.type === 'createAccount') {
            const { username: newUsername, password } = data;
            const playerDir = path.join(PLAYER_FOLDER, newUsername);

            if (fs.existsSync(playerDir)) {
                ws.send(JSON.stringify({ type: 'createAccountResponse', success: false, error: 'Username exists' }));
            } else {
                fs.mkdirSync(playerDir);
                savePlayerData(newUsername, { password, gold: 0, inventory: {}, actors: {}, mapId: 1, x: 0, y: 0, variables: {}, guildId: null });
                logPlayer(newUsername, 'Account created');
                ws.send(JSON.stringify({ type: 'createAccountResponse', success: true }));
            }
            return;
        }

        // Login
        if (data.type === 'login') {
            const { username: loginUsername, password } = data;
            const playerData = loadPlayerData(loginUsername);
            if (playerData && playerData.password === password) {
                if (connectedPlayers.has(loginUsername)) {
                    ws.send(JSON.stringify({ type: 'loginResponse', success: false, error: 'User already logged in' }));
                    return;
                }
                username = loginUsername;
                connectedPlayers.set(username, { ws, mapId: playerData.mapId || 1, x: playerData.x || 0, y: playerData.y || 0, direction: 2, partyId: null, guildId: playerData.guildId });
                ws.send(JSON.stringify({ type: 'loginResponse', success: true }));
                logPlayer(username, 'Player logged in');
                // Send other players' data to this client
                const playersOnMap = Array.from(connectedPlayers.entries())
                    .filter(([u, p]) => u !== username && p.mapId === playerData.mapId)
                    .map(([u, p]) => ({ username: u, mapId: p.mapId, x: p.x, y: p.y, direction: p.direction }));
                ws.send(JSON.stringify({ type: 'playerList', players: playersOnMap }));
                // Broadcast this player's presence
                broadcastToMap(playerData.mapId, { type: 'playerJoin', username, mapId: playerData.mapId, x: playerData.x, y: playerData.y, direction: 2 }, username);
            } else {
                ws.send(JSON.stringify({ type: 'loginResponse', success: false, error: 'Invalid username/password' }));
            }
            return;
        }

        // Save player data
        if (data.type === 'saveData') {
            const { username: saveUsername, playerData } = data;
            if (saveUsername && playerData && saveUsername === username) {
                const storedData = loadPlayerData(saveUsername) || {};
                Object.assign(storedData, playerData);
                savePlayerData(saveUsername, storedData);
                logPlayer(saveUsername, 'Data saved');
                // Update connectedPlayers
                if (playerData.mapId && playerData.x != null && playerData.y != null) {
                    const player = connectedPlayers.get(username);
                    if (player) {
                        player.mapId = playerData.mapId;
                        player.x = playerData.x;
                        player.y = playerData.y;
                        player.direction = playerData.direction || player.direction;
                        // Broadcast movement
                        broadcastToMap(player.mapId, { type: 'playerMove', username, x: player.x, y: player.y, direction: player.direction }, username);
                    }
                }
            }
            return;
        }

        // Load player data
        if (data.type === 'loadData') {
            const { username: loadUsername } = data;
            if (loadUsername === username) {
                const playerData = loadPlayerData(loadUsername);
                if (playerData) {
                    ws.send(JSON.stringify({ type: 'loadDataResponse', success: true, data: playerData }));
                    logPlayer(loadUsername, 'Data loaded');
                } else {
                    ws.send(JSON.stringify({ type: 'loadDataResponse', success: false, error: 'No data found' }));
                }
            }
            return;
        }

        // Player movement update
        if (data.type === 'playerMove' && username) {
            const { x, y, direction, mapId } = data;
            const player = connectedPlayers.get(username);
            if (player && mapId === player.mapId) {
                player.x = x;
                player.y = y;
                player.direction = direction;
                broadcastToMap(mapId, { type: 'playerMove', username, x, y, direction }, username);
            }
            return;
        }

        // Chat message
        if (data.type === 'chat' && username) {
            const { message, scope, targetId } = data;
            if (scope === 'global') {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'chat', scope: 'global', username, message }));
                    }
                });
            } else if (scope === 'party' && targetId) {
                broadcastToParty(targetId, { type: 'chat', scope: 'party', username, message });
            } else if (scope === 'guild' && targetId) {
                const guild = guilds.get(targetId);
                if (guild) {
                    for (const member of guild.members) {
                        const player = connectedPlayers.get(member);
                        if (player && player.ws.readyState === WebSocket.OPEN) {
                            player.ws.send(JSON.stringify({ type: 'chat', scope: 'guild', username, message }));
                        }
                    }
                }
            }
            return;
        }

        // Party invite
        if (data.type === 'partyInvite' && username) {
            const { targetUsername } = data;
            const player = connectedPlayers.get(targetUsername);
            if (player && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify({ type: 'partyInvite', fromUsername: username }));
            }
            return;
        }

        // Party accept
        if (data.type === 'partyAccept' && username) {
            const { fromUsername } = data;
            let partyId = null;
            const leader = connectedPlayers.get(fromUsername);
            if (leader) {
                partyId = leader.partyId;
                if (!partyId) {
                    partyId = nextPartyId++;
                    parties.set(partyId, { leader: fromUsername, members: [fromUsername] });
                    leader.partyId = partyId;
                }
                const player = connectedPlayers.get(username);
                if (player && !player.partyId) {
                    player.partyId = partyId;
                    parties.get(partyId).members.push(username);
                    broadcastToParty(partyId, { type: 'partyUpdate', partyId, members: parties.get(partyId).members });
                }
            }
            return;
        }

        // Party leave
        if (data.type === 'partyLeave' && username) {
            const player = connectedPlayers.get(username);
            if (player && player.partyId) {
                const partyId = player.partyId;
                const party = parties.get(partyId);
                if (party) {
                    party.members = party.members.filter(m => m !== username);
                    player.partyId = null;
                    if (party.members.length === 0) {
                        parties.delete(partyId);
                    } else {
                        if (party.leader === username) {
                            party.leader = party.members[0] || null;
                        }
                        broadcastToParty(partyId, { type: 'partyUpdate', partyId, members: party.members, leader: party.leader });
                    }
                }
            }
            return;
        }

        // Guild create
        if (data.type === 'guildCreate' && username) {
            const { guildName } = data;
            const player = connectedPlayers.get(username);
            if (player && !player.guildId) {
                const guildId = nextGuildId++;
                guilds.set(guildId, { name: guildName, leader: username, members: [username] });
                player.guildId = guildId;
                savePlayerData(username, { ...loadPlayerData(username), guildId });
                saveGuilds();
                ws.send(JSON.stringify({ type: 'guildUpdate', guildId, name: guildName, members: [username], leader: username }));
            }
            return;
        }

        // Guild invite
        if (data.type === 'guildInvite' && username) {
            const { targetUsername } = data;
            const player = connectedPlayers.get(username);
            const target = connectedPlayers.get(targetUsername);
            if (player && target && player.guildId && guilds.get(player.guildId)?.leader === username) {
                target.ws.send(JSON.stringify({ type: 'guildInvite', guildId: player.guildId, guildName: guilds.get(player.guildId).name, fromUsername: username }));
            }
            return;
        }

        // Guild accept
        if (data.type === 'guildAccept' && username) {
            const { guildId } = data;
            const player = connectedPlayers.get(username);
            if (player && !player.guildId && guilds.has(guildId)) {
                player.guildId = guildId;
                guilds.get(guildId).members.push(username);
                savePlayerData(username, { ...loadPlayerData(username), guildId });
                saveGuilds();
                const guild = guilds.get(guildId);
                for (const member of guild.members) {
                    const memberPlayer = connectedPlayers.get(member);
                    if (memberPlayer && memberPlayer.ws.readyState === WebSocket.OPEN) {
                        memberPlayer.ws.send(JSON.stringify({ type: 'guildUpdate', guildId, name: guild.name, members: guild.members, leader: guild.leader }));
                    }
                }
            }
            return;
        }

        // Guild leave
        if (data.type === 'guildLeave' && username) {
            const player = connectedPlayers.get(username);
            if (player && player.guildId) {
                const guildId = player.guildId;
                const guild = guilds.get(guildId);
                if (guild) {
                    guild.members = guild.members.filter(m => m !== username);
                    player.guildId = null;
                    savePlayerData(username, { ...loadPlayerData(username), guildId: null });
                    if (guild.members.length === 0) {
                        guilds.delete(guildId);
                    } else if (guild.leader === username) {
                        guild.leader = guild.members[0] || null;
                    }
                    saveGuilds();
                    for (const member of guild.members) {
                        const memberPlayer = connectedPlayers.get(member);
                        if (memberPlayer && memberPlayer.ws.readyState === WebSocket.OPEN) {
                            memberPlayer.ws.send(JSON.stringify({ type: 'guildUpdate', guildId, name: guild.name, members: guild.members, leader: guild.leader }));
                        }
                    }
                }
            }
            return;
        }
    });

    ws.on('close', () => {
        if (username) {
            const player = connectedPlayers.get(username);
            if (player) {
                broadcastToMap(player.mapId, { type: 'playerLeave', username });
                if (player.partyId) {
                    const party = parties.get(player.partyId);
                    if (party) {
                        party.members = party.members.filter(m => m !== username);
                        if (party.members.length === 0) {
                            parties.delete(player.partyId);
                        } else {
                            if (party.leader === username) {
                                party.leader = party.members[0] || null;
                            }
                            broadcastToParty(player.partyId, { type: 'partyUpdate', partyId: player.partyId, members: party.members, leader: party.leader });
                        }
                    }
                }
                connectedPlayers.delete(username);
            }
        }
        logGlobal(`Client disconnected: ${ip}`);
    });

    ws.on('error', (err) => logGlobal(`WebSocket error: ${err.message}`));
});

// Listen on Replit-assigned port
server.listen(PORT, () => {
    logGlobal(`Server running on port ${PORT}`);
    logGlobal(`Clients connect using wss://<YOUR_REPL_NAME>.username.repl.co`);
});
