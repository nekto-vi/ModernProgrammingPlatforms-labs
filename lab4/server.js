const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOARD_SIZE = 10;
const FLEET_COUNTS = new Map([[1, 4], [2, 3], [3, 2], [4, 1]]);
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
};

function loadRooms(filePath = ROOMS_FILE) {
    if (!fs.existsSync(filePath)) return {};
    const contents = fs.readFileSync(filePath, 'utf8');
    const rooms = JSON.parse(contents);
    if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) {
        throw new Error(`Invalid saved game data in ${filePath}`);
    }
    return rooms;
}

function saveRooms(rooms, filePath = ROOMS_FILE) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(rooms, null, 2));
    fs.renameSync(temporaryPath, filePath);
}

function validateFleet(ships, complete = false) {
    if (!Array.isArray(ships)) return false;
    const counts = new Map();
    const occupied = new Set();

    for (const ship of ships) {
        if (!Array.isArray(ship) || ship.length < 1 || ship.length > 4) return false;
        counts.set(ship.length, (counts.get(ship.length) || 0) + 1);
        if (counts.get(ship.length) > FLEET_COUNTS.get(ship.length)) return false;

        const cells = new Set();
        const shipCells = [];
        for (const cell of ship) {
            if (!cell || !Number.isInteger(cell.x) || !Number.isInteger(cell.y)
                || cell.x < 0 || cell.y < 0 || cell.x >= BOARD_SIZE || cell.y >= BOARD_SIZE) {
                return false;
            }
            const key = `${cell.x},${cell.y}`;
            if (cells.has(key) || occupied.has(key)) return false;
            cells.add(key);
            shipCells.push(cell);
        }

        for (const cell of shipCells) {
            for (let neighborY = cell.y - 1; neighborY <= cell.y + 1; neighborY += 1) {
                for (let neighborX = cell.x - 1; neighborX <= cell.x + 1; neighborX += 1) {
                    if (occupied.has(`${neighborX},${neighborY}`)) return false;
                }
            }
        }
        shipCells.forEach((cell) => occupied.add(`${cell.x},${cell.y}`));

        const sameRow = ship.every((cell) => cell.y === ship[0].y);
        const sameColumn = ship.every((cell) => cell.x === ship[0].x);
        if (ship.length > 1 && !sameRow && !sameColumn) return false;
        const coordinates = ship.map((cell) => sameRow ? cell.x : cell.y).sort((a, b) => a - b);
        if (coordinates.some((coordinate, index) => index > 0 && coordinate !== coordinates[index - 1] + 1)) {
            return false;
        }
    }

    return !complete || [...FLEET_COUNTS].every(([length, count]) => counts.get(length) === count);
}

function createPlayer(id, name) {
    return { id, name, ships: [], shots: [], ready: false, placementVersion: 0 };
}

function roomCode() {
    return Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
}

function getPlayerIndex(room, playerId) {
    return room.players.findIndex((player) => player && player.id === playerId);
}

function roomView(room, playerIndex) {
    const ownPlayer = room.players[playerIndex];
    const enemy = room.players[1 - playerIndex];
    return {
        type: 'state',
        roomId: room.id,
        boardSize: BOARD_SIZE,
        status: room.status,
        turn: room.turn,
        winner: room.winner,
        playerIndex,
        players: room.players.map((player) => player ? player.name : null),
        ready: room.players.map((player) => Boolean(player?.ready)),
        placementVersion: ownPlayer.placementVersion || 0,
        ownShips: ownPlayer.ships,
        incomingShots: enemy ? enemy.shots : [],
        outgoingShots: ownPlayer.shots
    };
}

function sendJson(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function createGameServer({ dataFile = ROOMS_FILE, publicDir = PUBLIC_DIR, logger = console.error } = {}) {
    const rooms = loadRooms(dataFile);
    for (const room of Object.values(rooms)) {
        for (const player of room.players) {
            if (player && !Number.isSafeInteger(player.placementVersion)) player.placementVersion = 0;
        }
        if (room.status === 'waiting') {
            room.status = 'setup';
            for (const player of room.players) {
                if (player) {
                    player.ships = [];
                    player.shots = [];
                    player.ready = false;
                }
            }
        }
    }
    const subscribers = new Map();

    function persist() {
        saveRooms(rooms, dataFile);
    }

    function broadcast(room) {
        const sockets = subscribers.get(room.id);
        if (!sockets) return;
        for (const socket of sockets) {
            if (socket.playerIndex !== undefined) {
                sendJson(socket, roomView(room, socket.playerIndex));
            }
        }
    }

    function fail(socket, message, details = {}) {
        sendJson(socket, { type: 'error', message, ...details });
    }

    function joinRoom(socket, command) {
        const name = typeof command.name === 'string' ? command.name.trim().slice(0, 24) : '';
        const playerId = command.playerId;
        if (!name || typeof playerId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(playerId)) {
            fail(socket, 'Введите имя, чтобы начать игру.');
            return;
        }

        let room;
        if (command.type === 'create') {
            let id;
            do {
                id = roomCode();
            } while (rooms[id]);
            room = {
                id,
                status: 'setup',
                turn: 0,
                winner: null,
                players: [createPlayer(playerId, name), null]
            };
            rooms[id] = room;
            persist();
        } else {
            const id = typeof command.roomId === 'string' ? command.roomId.trim().toUpperCase() : '';
            room = rooms[id];
            if (!room) {
                fail(socket, 'Комната не найдена. Проверьте код и попробуйте снова.', { code: 'room_unavailable' });
                return;
            }

            let playerIndex = getPlayerIndex(room, playerId);
            if (playerIndex < 0) {
                playerIndex = room.players.findIndex((player) => player === null);
                if (playerIndex < 0 || room.status !== 'setup') {
                    fail(socket, 'В этой комнате уже началась игра или нет свободного места.', { code: 'room_unavailable' });
                    return;
                }
                room.players[playerIndex] = createPlayer(playerId, name);
                persist();
            } else {
                room.players[playerIndex].name = name;
            }
        }

        const playerIndex = getPlayerIndex(room, playerId);
        if (socket.roomId) subscribers.get(socket.roomId)?.delete(socket);
        socket.roomId = room.id;
        socket.playerIndex = playerIndex;
        if (!subscribers.has(room.id)) subscribers.set(room.id, new Set());
        subscribers.get(room.id).add(socket);
        broadcast(room);
    }

    function updatePlacement(socket, command) {
        const room = rooms[socket.roomId];
        if (!room || socket.playerIndex === undefined) return;
        const player = room.players[socket.playerIndex];
        if (room.status !== 'setup' || player.ready) {
            fail(socket, 'Расстановку уже нельзя изменить.');
            return;
        }
        if (!Number.isSafeInteger(command.placementVersion)
            || command.placementVersion !== player.placementVersion) {
            fail(socket, 'Конфликт изменений: другая вкладка уже сохранила более новую расстановку. Показана актуальная версия; повтори действие, если оно всё ещё нужно.', {
                code: 'conflict',
                state: roomView(room, socket.playerIndex)
            });
            return;
        }
        if (!validateFleet(command.ships)) {
            fail(socket, 'Расстановка некорректна: корабли должны быть прямыми и не должны пересекаться или соприкасаться.');
            return;
        }
        player.ships = command.ships;
        player.placementVersion += 1;
        persist();
        broadcast(room);
    }

    function markReady(socket) {
        const room = rooms[socket.roomId];
        if (!room || socket.playerIndex === undefined) return;
        if (room.status !== 'setup') {
            fail(socket, 'Партия уже началась.');
            return;
        }
        const player = room.players[socket.playerIndex];
        if (!validateFleet(player.ships, true)) {
            fail(socket, 'Сначала расставь все корабли.');
            return;
        }
        player.ready = true;
        if (room.players.every((participant) => participant && participant.ready)) {
            room.status = 'playing';
            room.turn = 0;
        }
        persist();
        broadcast(room);
    }

    function shoot(socket, command) {
        const room = rooms[socket.roomId];
        if (!room || socket.playerIndex === undefined) return;
        if (room.status !== 'playing') {
            fail(socket, 'Игра ещё не началась.');
            return;
        }
        if (room.turn !== socket.playerIndex) {
            fail(socket, 'Сейчас ход соперника. Получено актуальное состояние игры.', {
                code: 'conflict',
                state: roomView(room, socket.playerIndex)
            });
            return;
        }
        const { x, y } = command;
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) {
            fail(socket, 'Выберите клетку на поле.');
            return;
        }
        const player = room.players[socket.playerIndex];
        if (player.shots.some((shot) => shot.x === x && shot.y === y)) {
            fail(socket, 'Конфликт ходов: в эту клетку уже выстрелили. Показано актуальное состояние игры.', {
                code: 'conflict',
                state: roomView(room, socket.playerIndex)
            });
            return;
        }

        const enemy = room.players[1 - socket.playerIndex];
        const targetShip = enemy.ships.find((ship) => ship.some((cell) => cell.x === x && cell.y === y));
        const hit = Boolean(targetShip);
        player.shots.push({ x, y, hit });
        if (hit && targetShip.every((cell) => player.shots.some((shot) => shot.x === cell.x && shot.y === cell.y && shot.hit))) {
            for (const shipCell of targetShip) {
                for (let neighborY = shipCell.y - 1; neighborY <= shipCell.y + 1; neighborY += 1) {
                    for (let neighborX = shipCell.x - 1; neighborX <= shipCell.x + 1; neighborX += 1) {
                        if (neighborX < 0 || neighborY < 0 || neighborX >= BOARD_SIZE || neighborY >= BOARD_SIZE) continue;
                        const neighboringShot = player.shots.find((shot) => shot.x === neighborX && shot.y === neighborY);
                        if (neighboringShot) {
                            if (!neighboringShot.hit) neighboringShot.blocked = true;
                        } else {
                            player.shots.push({ x: neighborX, y: neighborY, hit: false, blocked: true });
                        }
                    }
                }
            }
        }
        const allCells = enemy.ships.flat();
        if (allCells.every((cell) => player.shots.some((shot) => shot.x === cell.x && shot.y === cell.y && shot.hit))) {
            room.status = 'finished';
            room.winner = socket.playerIndex;
        } else if (!hit) {
            room.turn = 1 - socket.playerIndex;
        }
        persist();
        broadcast(room);
    }

    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const requestedPath = pathname === '/' ? '/index.html' : pathname;
        const filePath = path.resolve(publicDir, `.${requestedPath}`);
        if (!filePath.startsWith(`${path.resolve(publicDir)}${path.sep}`)) {
            response.writeHead(404).end('Not found');
            return;
        }
        fs.readFile(filePath, (error, contents) => {
            if (error) {
                response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
                return;
            }
            response.writeHead(200, {
                'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
                'Cache-Control': 'no-store'
            });
            response.end(contents);
        });
    });

    const webSocketServer = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
    webSocketServer.on('connection', (socket) => {
        socket.on('message', (rawMessage) => {
            try {
                const command = JSON.parse(rawMessage.toString());
                if (command.type === 'create' || command.type === 'join') {
                    joinRoom(socket, command);
                } else if (command.type === 'placement') {
                    updatePlacement(socket, command);
                } else if (command.type === 'ready') {
                    markReady(socket);
                } else if (command.type === 'shoot') {
                    shoot(socket, command);
                } else {
                    fail(socket, 'Неизвестная команда.');
                }
            } catch (error) {
                logger('Could not process game command', error);
                fail(socket, 'Не удалось обработать действие. Попробуйте ещё раз.');
            }
        });
        socket.on('close', () => {
            if (socket.roomId) subscribers.get(socket.roomId)?.delete(socket);
        });
    });

    return {
        server,
        webSocketServer,
        listen(port = PORT) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, () => {
                    server.removeListener('error', reject);
                    resolve(server.address());
                });
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                webSocketServer.close((socketError) => {
                    if (socketError) reject(socketError);
                    else server.close((serverError) => serverError ? reject(serverError) : resolve());
                });
                for (const socket of webSocketServer.clients) socket.terminate();
            });
        }
    };
}

if (require.main === module) {
    const gameServer = createGameServer();
    gameServer.listen().then((address) => {
        console.log(`Sea Battle is listening on port ${address.port}`);
    }).catch((error) => {
        console.error('Could not start Sea Battle', error);
        process.exitCode = 1;
    });
}

module.exports = { BOARD_SIZE, createGameServer, loadRooms, saveRooms };
