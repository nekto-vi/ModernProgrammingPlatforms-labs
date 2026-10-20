const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createGameServer } = require('../server');

async function createHarness() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-battle-'));
    const dataFile = path.join(directory, 'rooms.json');
    const game = createGameServer({ dataFile, logger: () => {} });
    const address = await game.listen(0);
    return {
        game,
        dataFile,
        directory,
        baseUrl: `http://127.0.0.1:${address.port}`,
        url: `ws://127.0.0.1:${address.port}/ws`,
        async close() {
            await game.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    };
}

async function connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return socket;
}

function waitForMessage(socket, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('message', onMessage);
            reject(new Error('Timed out waiting for WebSocket message'));
        }, 2000);
        function onMessage(data) {
            const message = JSON.parse(data.toString());
            if (!predicate(message)) return;
            clearTimeout(timeout);
            socket.off('message', onMessage);
            resolve(message);
        }
        socket.on('message', onMessage);
    });
}

function waitForAnyMessage(sockets, predicate) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            sockets.forEach((socket) => socket.off('message', onMessage));
            reject(new Error('Timed out waiting for WebSocket message'));
        }, 2000);
        function onMessage(data) {
            const message = JSON.parse(data.toString());
            if (!predicate(message)) return;
            clearTimeout(timeout);
            sockets.forEach((socket) => socket.off('message', onMessage));
            resolve(message);
        }
        sockets.forEach((socket) => socket.on('message', onMessage));
    });
}

function closeSocket(socket) {
    return new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once('close', resolve);
        socket.close();
    });
}

function fleet(offset = 0) {
    return [
        [{ x: offset, y: 0 }, { x: offset + 1, y: 0 }, { x: offset + 2, y: 0 }, { x: offset + 3, y: 0 }],
        [{ x: offset, y: 2 }, { x: offset + 1, y: 2 }, { x: offset + 2, y: 2 }],
        [{ x: offset, y: 4 }, { x: offset + 1, y: 4 }, { x: offset + 2, y: 4 }],
        [{ x: offset, y: 6 }, { x: offset + 1, y: 6 }],
        [{ x: offset + 3, y: 6 }, { x: offset + 4, y: 6 }],
        [{ x: offset + 6, y: 6 }, { x: offset + 7, y: 6 }],
        [{ x: offset, y: 8 }],
        [{ x: offset + 2, y: 8 }],
        [{ x: offset + 4, y: 8 }],
        [{ x: offset + 6, y: 8 }]
    ];
}

function sendAndWait(socket, command, predicate = (message) => message.type === 'state') {
    const response = waitForMessage(socket, predicate);
    socket.send(JSON.stringify(command));
    return response;
}

test('serves the game interface and static assets', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());

    const page = await fetch(harness.baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /Морской бой/);
    assert.match(html, /app\.js\?v=5/);

    const script = await fetch(`${harness.baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal(script.headers.get('cache-control'), 'no-store');
});

test('players place fleets and the game starts only after both are ready', async (t) => {
    const harness = await createHarness();
    const first = await connect(harness.url);
    const second = await connect(harness.url);
    let firstReplica;
    t.after(async () => {
        if (firstReplica) await closeSocket(firstReplica);
        await closeSocket(first);
        await closeSocket(second);
        await harness.close();
    });

    const firstInitialState = sendAndWait(first, { type: 'create', name: 'Аня', playerId: 'player-one' });
    const waiting = await firstInitialState;
    assert.equal(waiting.status, 'setup');
    assert.equal(waiting.boardSize, 10);
    assert.deepEqual(waiting.ownShips, []);

    const firstJoinedState = waitForMessage(first, (message) => message.type === 'state' && message.players[1] === 'Ира');
    const secondJoinedState = waitForMessage(second, (message) => message.type === 'state' && message.players[0] === 'Аня');
    second.send(JSON.stringify({ type: 'join', roomId: waiting.roomId, name: 'Ира', playerId: 'player-two' }));
    const [firstWithSecond, secondWithFirst] = await Promise.all([firstJoinedState, secondJoinedState]);
    assert.equal(firstWithSecond.status, 'setup');
    assert.equal(firstWithSecond.players[1], 'Ира');
    assert.equal(secondWithFirst.playerIndex, 1);
    assert.deepEqual(secondWithFirst.ownShips, []);

    const invalidReady = waitForMessage(first, (message) => message.type === 'error');
    first.send(JSON.stringify({ type: 'ready' }));
    assert.match((await invalidReady).message, /все корабли/i);

    const invalidPlacement = waitForMessage(first, (message) => message.type === 'error');
    first.send(JSON.stringify({
        type: 'placement',
        placementVersion: waiting.placementVersion,
        ships: [[{ x: 0, y: 0 }, { x: 2, y: 0 }]]
    }));
    assert.match((await invalidPlacement).message, /некорректна/i);

    const touchingShips = fleet();
    touchingShips[1] = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }];
    const touchingPlacement = waitForMessage(first, (message) => message.type === 'error');
    first.send(JSON.stringify({
        type: 'placement',
        placementVersion: waiting.placementVersion,
        ships: touchingShips
    }));
    assert.match((await touchingPlacement).message, /некорректна/i);

    const hasFleet = (message) => message.type === 'state' && message.ownShips.flat().length === 20;
    const firstFleetSaved = sendAndWait(first, {
        type: 'placement',
        placementVersion: waiting.placementVersion,
        ships: fleet()
    }, hasFleet);
    const secondFleetSaved = sendAndWait(second, {
        type: 'placement',
        placementVersion: secondWithFirst.placementVersion,
        ships: fleet(1)
    }, hasFleet);
    const [firstSetup, secondSetup] = await Promise.all([firstFleetSaved, secondFleetSaved]);
    assert.equal(firstSetup.ownShips.flat().length, 20);
    assert.equal(secondSetup.ownShips.flat().length, 20);
    assert.equal(firstSetup.opponentShips, undefined);

    const firstReadyState = sendAndWait(first, { type: 'ready' }, (message) => message.type === 'state' && message.ready[0]);
    const firstReady = await firstReadyState;
    assert.equal(firstReady.status, 'setup');
    assert.deepEqual(firstReady.ready, [true, false]);

    const firstPlayingState = waitForMessage(first, (message) => message.type === 'state' && message.status === 'playing');
    const secondPlayingState = sendAndWait(second, { type: 'ready' }, (message) => message.type === 'state' && message.status === 'playing');
    const [firstPlaying, secondPlaying] = await Promise.all([firstPlayingState, secondPlayingState]);
    assert.equal(firstPlaying.turn, 0);
    assert.equal(secondPlaying.playerIndex, 1);

    const target = secondPlaying.ownShips[0][0];
    firstReplica = await connect(harness.url);
    await sendAndWait(firstReplica, {
        type: 'join',
        roomId: waiting.roomId,
        name: 'Аня',
        playerId: 'player-one'
    }, (message) => message.type === 'state' && message.status === 'playing' && message.playerIndex === 0);
    const afterHitFirst = waitForMessage(first, (message) => message.type === 'state'
        && message.outgoingShots.some((shot) => shot.x === target.x && shot.y === target.y));
    const afterHitSecond = waitForMessage(second, (message) => message.type === 'state' && message.incomingShots.length === 1);
    const duplicateShotConflict = waitForAnyMessage([first, firstReplica],
        (message) => message.type === 'error' && message.code === 'conflict');
    first.send(JSON.stringify({ type: 'shoot', ...target }));
    firstReplica.send(JSON.stringify({ type: 'shoot', ...target }));
    const [hitState, hitOnOwnBoard, duplicateConflict] = await Promise.all([
        afterHitFirst,
        afterHitSecond,
        duplicateShotConflict
    ]);
    assert.equal(hitState.outgoingShots[0].hit, true);
    assert.equal(hitState.turn, 0);
    assert.equal(hitOnOwnBoard.incomingShots[0].hit, true);
    assert.match(duplicateConflict.message, /конфликт ходов/i);
    assert.equal(duplicateConflict.state.outgoingShots.filter((shot) => shot.x === target.x && shot.y === target.y).length, 1);

    for (const cell of secondPlaying.ownShips[0].slice(1, -1)) {
        const afterHit = waitForMessage(first, (message) => message.type === 'state'
            && message.outgoingShots.some((shot) => shot.x === cell.x && shot.y === cell.y && shot.hit));
        first.send(JSON.stringify({ type: 'shoot', ...cell }));
        await afterHit;
    }
    const sunkStatePromise = waitForMessage(first, (message) =>
        message.type === 'state' && message.outgoingShots.some((shot) => shot.blocked));
    const lastCell = secondPlaying.ownShips[0].at(-1);
    first.send(JSON.stringify({ type: 'shoot', ...lastCell }));
    const sunkState = await sunkStatePromise;
    assert.ok(sunkState.outgoingShots.some((shot) => shot.blocked && shot.x === 0 && shot.y === 1));

    const occupied = new Set(secondPlaying.ownShips.flat().map((cell) => `${cell.x},${cell.y}`));
    const miss = Array.from({ length: 10 * 10 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10) }))
        .find((cell) => !occupied.has(`${cell.x},${cell.y}`)
            && !sunkState.outgoingShots.some((shot) => shot.x === cell.x && shot.y === cell.y));
    const afterMiss = waitForMessage(first, (message) => message.type === 'state'
        && message.outgoingShots.some((shot) => shot.x === miss.x && shot.y === miss.y));
    first.send(JSON.stringify({ type: 'shoot', ...miss }));
    const missState = await afterMiss;
    assert.equal(missState.outgoingShots.find((shot) => shot.x === miss.x && shot.y === miss.y).hit, false);
    assert.equal(missState.turn, 1);
});

test('saved setup restores ships and readiness after server restart', async (t) => {
    const harness = await createHarness();
    const player = await connect(harness.url);
    const initialState = sendAndWait(player, { type: 'create', name: 'Миша', playerId: 'stable-player' });
    const created = await initialState;
    const fleetSaved = sendAndWait(player, {
        type: 'placement',
        placementVersion: created.placementVersion,
        ships: fleet()
    });
    await fleetSaved;
    const readyState = sendAndWait(player, { type: 'ready' }, (message) => message.type === 'state' && message.ready[0]);
    await readyState;
    assert.ok(fs.existsSync(harness.dataFile));
    await closeSocket(player);
    await harness.game.close();

    const restarted = createGameServer({ dataFile: harness.dataFile, logger: () => {} });
    const address = await restarted.listen(0);
    const reconnectedPlayer = await connect(`ws://127.0.0.1:${address.port}/ws`);
    t.after(async () => {
        await closeSocket(reconnectedPlayer);
        await restarted.close();
        fs.rmSync(harness.directory, { recursive: true, force: true });
    });
    const restoredState = waitForMessage(reconnectedPlayer, (message) => message.type === 'state');
    reconnectedPlayer.send(JSON.stringify({
        type: 'join',
        roomId: created.roomId,
        name: 'Миша',
        playerId: 'stable-player'
    }));
    const restored = await restoredState;
    assert.equal(restored.status, 'setup');
    assert.equal(restored.ready[restored.playerIndex], true);
    assert.deepEqual(restored.ownShips, fleet());
});

test('rejects stale fleet edits and returns the latest version for retry', async (t) => {
    const harness = await createHarness();
    const firstTab = await connect(harness.url);
    const secondTab = await connect(harness.url);
    t.after(async () => {
        await closeSocket(firstTab);
        await closeSocket(secondTab);
        await harness.close();
    });

    const created = await sendAndWait(firstTab, {
        type: 'create',
        name: 'Аня',
        playerId: 'same-player'
    });
    const joined = await sendAndWait(secondTab, {
        type: 'join',
        roomId: created.roomId,
        name: 'Аня',
        playerId: 'same-player'
    });
    assert.equal(joined.placementVersion, 0);

    const firstVersion = await sendAndWait(firstTab, {
        type: 'placement',
        placementVersion: created.placementVersion,
        ships: fleet()
    }, (message) => message.type === 'state' && message.placementVersion === 1);
    assert.deepEqual(firstVersion.ownShips, fleet());

    const staleEdit = waitForMessage(secondTab, (message) => message.type === 'error' && message.code === 'conflict');
    secondTab.send(JSON.stringify({
        type: 'placement',
        placementVersion: joined.placementVersion,
        ships: fleet(1)
    }));
    const conflict = await staleEdit;
    assert.match(conflict.message, /конфликт изменений/i);
    assert.equal(conflict.state.placementVersion, 1);
    assert.deepEqual(conflict.state.ownShips, fleet());

    const retried = await sendAndWait(secondTab, {
        type: 'placement',
        placementVersion: conflict.state.placementVersion,
        ships: fleet(2)
    }, (message) => message.type === 'state' && message.placementVersion === 2);
    assert.deepEqual(retried.ownShips, fleet(2));
});
