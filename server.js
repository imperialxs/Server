// server.js
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000; // Replit assigns port dynamically
const PLAYER_FOLDER = path.join(__dirname, 'PlayerAccounts');
const GLOBAL_LOG = path.join(__dirname, 'server_log.txt');

// Ensure Player Accounts folder exists
if (!fs.existsSync(PLAYER_FOLDER)) fs.mkdirSync(PLAYER_FOLDER);

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

// HTTP server for WebSocket upgrade
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logGlobal(`Client connected: ${ip}`);

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
            const { username, password } = data;
            const playerDir = path.join(PLAYER_FOLDER, username);

            if (fs.existsSync(playerDir)) {
                ws.send(JSON.stringify({ type: 'createAccountResponse', success: false, error: 'Username exists' }));
            } else {
                fs.mkdirSync(playerDir);
                savePlayerData(username, { password, gold: 0, inventory: {}, actors: {}, mapId: 1, x: 0, y: 0, variables: {} });
                logPlayer(username, 'Account created');
                ws.send(JSON.stringify({ type: 'createAccountResponse', success: true }));
            }
            return;
        }

        // Login
        if (data.type === 'login') {
            const { username, password } = data;
            const playerData = loadPlayerData(username);
            if (playerData && playerData.password === password) {
                ws.send(JSON.stringify({ type: 'loginResponse', success: true }));
                logPlayer(username, 'Player logged in');
            } else {
                ws.send(JSON.stringify({ type: 'loginResponse', success: false, error: 'Invalid username/password' }));
            }
            return;
        }

        // Save player data
        if (data.type === 'saveData') {
            const { username, playerData } = data;
            if (username && playerData) {
                const storedData = loadPlayerData(username) || {};
                Object.assign(storedData, playerData);
                savePlayerData(username, storedData);
                logPlayer(username, 'Data saved');
            }
            return;
        }

        // Load player data
        if (data.type === 'loadData') {
            const { username } = data;
            const playerData = loadPlayerData(username);
            if (playerData) {
                ws.send(JSON.stringify({ type: 'loadDataResponse', success: true, data: playerData }));
                logPlayer(username, 'Data loaded');
            } else {
                ws.send(JSON.stringify({ type: 'loadDataResponse', success: false, error: 'No data found' }));
            }
            return;
        }
    });

    ws.on('close', () => logGlobal(`Client disconnected: ${ip}`));
    ws.on('error', (err) => logGlobal(`WebSocket error: ${err.message}`));
});

// Listen on Replit-assigned port
server.listen(PORT, () => {
    logGlobal(`Server running on port ${PORT}`);
    logGlobal(`Clients connect using wss://<YOUR_REPL_NAME>.username.repl.co`);
});
