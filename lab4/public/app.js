const FLEET_COUNTS = new Map([[1, 4], [2, 3], [3, 2], [4, 1]]);
const lobbyView = document.querySelector('#lobbyView');
const gameView = document.querySelector('#gameView');
const nameInput = document.querySelector('#playerName');
const roomCodeInput = document.querySelector('#roomCode');
const lobbyMessage = document.querySelector('#lobbyMessage');
const gameMessage = document.querySelector('#gameMessage');
const connectionBadge = document.querySelector('#connectionBadge');
const connectionText = document.querySelector('#connectionText');
const playerIdKey = 'cellBattlePlayerId';
const playerId = localStorage.getItem(playerIdKey) || crypto.randomUUID();
localStorage.setItem(playerIdKey, playerId);

let socket;
let queuedCommand;
let reconnectTimeout;
let retryDelay = 600;
let currentRoom;
let currentState;
let selectedLength = 4;
let vertical = false;
let pendingPlacement = false;
let dragState;

function setConnection(isConnected) {
    connectionBadge.classList.toggle('connected', isConnected);
    connectionBadge.classList.toggle('disconnected', !isConnected);
    connectionText.textContent = isConnected ? 'На связи' : 'Переподключение...';
}

function connect() {
    clearTimeout(reconnectTimeout);
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener('open', () => {
        retryDelay = 600;
        setConnection(true);
        if (currentRoom) {
            socket.send(JSON.stringify({ type: 'join', roomId: currentRoom, name: nameInput.value.trim(), playerId }));
        }
        if (queuedCommand) {
            socket.send(JSON.stringify(queuedCommand));
            queuedCommand = null;
        }
    });
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'error') {
            pendingPlacement = false;
            showMessage(message.message, true);
            if (currentState) renderGame(currentState);
        } else if (message.type === 'state') {
            currentRoom = message.roomId;
            currentState = message;
            pendingPlacement = false;
            renderGame(message);
        }
    });
    socket.addEventListener('close', () => {
        setConnection(false);
        reconnectTimeout = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.7, 6000);
    });
    socket.addEventListener('error', () => socket.close());
}

function send(command) {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(command));
    } else {
        queuedCommand = command;
        lobbyMessage.textContent = 'Нет соединения с сервером. Подключаемся снова...';
    }
}

function showMessage(message, isError = false) {
    const target = gameView.hidden
        ? lobbyMessage
        : currentState?.status === 'setup' ? gameMessage : document.querySelector('#playMessage');
    target.textContent = message;
    target.classList.toggle('error', isError);
}

function startRoom(type) {
    const name = nameInput.value.trim();
    if (!name) {
        lobbyMessage.textContent = 'Сначала введи своё имя.';
        nameInput.focus();
        return;
    }
    lobbyMessage.textContent = '';
    send({ type, name, playerId, roomId: roomCodeInput.value.trim().toUpperCase() });
}

function countShips(ships) {
    const counts = new Map();
    for (const ship of ships) counts.set(ship.length, (counts.get(ship.length) || 0) + 1);
    return counts;
}

function remainingShips(ships, length) {
    return FLEET_COUNTS.get(length) - (countShips(ships).get(length) || 0);
}

function fleetIsComplete(ships) {
    const counts = countShips(ships);
    return [...FLEET_COUNTS].every(([length, amount]) => counts.get(length) === amount);
}

function makeCell(className, label, onClick) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `cell ${className}`;
    cell.setAttribute('aria-label', label);
    if (onClick) cell.addEventListener('click', onClick);
    else cell.disabled = true;
    return cell;
}

function renderShipChoices(ships, isLocked) {
    const choices = document.querySelector('#shipChoices');
    choices.replaceChildren();
    for (const length of [4, 3, 2, 1]) {
        const remaining = remainingShips(ships, length);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `ship-choice${selectedLength === length ? ' selected' : ''}`;
        button.disabled = isLocked || remaining === 0;
        button.setAttribute('aria-pressed', String(selectedLength === length));
        button.innerHTML = `<span>${length}-палубный</span><span class="ship-count">${remaining} / ${FLEET_COUNTS.get(length)}</span>`;
        button.addEventListener('click', () => {
            selectedLength = length;
            renderGame(currentState);
        });
        choices.append(button);
    }
}

function renderSetupBoard(element, state) {
    const ships = state.ownShips || [];
    const occupied = new Set(ships.flat().map(({ x, y }) => `${x},${y}`));
    const locked = state.ready[state.playerIndex] || pendingPlacement;
    element.replaceChildren();
    element.classList.remove('disabled-board');
    for (let y = 0; y < state.boardSize; y += 1) {
        for (let x = 0; x < state.boardSize; x += 1) {
            const hasShip = occupied.has(`${x},${y}`);
            const cell = makeCell(hasShip ? 'ship' : '', `${String.fromCharCode(65 + y)}${x + 1}${hasShip ? ', корабль' : ''}`, null);
            cell.classList.add('setup-cell');
            cell.dataset.x = String(x);
            cell.dataset.y = String(y);
            cell.disabled = locked || hasShip;
            element.append(cell);
        }
    }
    element.onpointerdown = (event) => {
        const cell = event.target.closest('.setup-cell');
        if (!cell || cell.disabled || locked || !selectedLength || pendingPlacement) return;
        event.preventDefault();
        dragState = { x: Number(cell.dataset.x), y: Number(cell.dataset.y) };
        setPlacementPreview(element, state);
    };
    element.onpointermove = (event) => {
        if (!dragState) return;
        const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.setup-cell');
        if (!cell || !element.contains(cell)) return;
        dragState.endX = Number(cell.dataset.x);
        dragState.endY = Number(cell.dataset.y);
        setPlacementPreview(element, state);
    };
}

function getPlacementPreview(ships, state) {
    if (!dragState) return { cells: [], valid: false, lengthMatches: false };
    if (remainingShips(ships, selectedLength) <= 0) {
        return { cells: [], valid: false, lengthMatches: false };
    }
    const endX = dragState.endX ?? dragState.x;
    const endY = dragState.endY ?? dragState.y;
    const dx = endX - dragState.x;
    const dy = endY - dragState.y;
    const stationary = dx === 0 && dy === 0;
    const horizontal = stationary ? !vertical : dy === 0 || (dx !== 0 && dy !== 0 && Math.abs(dx) >= Math.abs(dy));
    const aligned = dx === 0 || dy === 0;
    const direction = stationary ? 1 : horizontal ? Math.sign(dx) || 1 : Math.sign(dy) || 1;
    const length = dx === 0 && dy === 0 ? selectedLength : Math.max(Math.abs(dx), Math.abs(dy)) + 1;
    const cells = Array.from({ length }, (_, offset) => ({
        x: dragState.x + (horizontal ? direction * offset : 0),
        y: dragState.y + (horizontal ? 0 : direction * offset)
    }));
    const lengthMatches = length === selectedLength;
    const inBounds = cells.every((cell) =>
        cell.x >= 0 && cell.y >= 0 && cell.x < state.boardSize && cell.y < state.boardSize);
    const occupied = new Set(ships.flat().map(({ x: cellX, y: cellY }) => `${cellX},${cellY}`));
    const noOverlap = cells.every((cell) => !occupied.has(`${cell.x},${cell.y}`));
    const noTouching = cells.every((cell) => {
        for (let neighborY = cell.y - 1; neighborY <= cell.y + 1; neighborY += 1) {
            for (let neighborX = cell.x - 1; neighborX <= cell.x + 1; neighborX += 1) {
                if (occupied.has(`${neighborX},${neighborY}`)) return false;
            }
        }
        return true;
    });
    return { cells, valid: aligned && lengthMatches && inBounds && noOverlap && noTouching, lengthMatches };
}

function setPlacementPreview(element, state) {
    const preview = getPlacementPreview(state.ownShips, state);
    for (const cell of element.querySelectorAll('.setup-cell')) {
        const isPreviewed = preview.cells.some(({ x, y }) => x === Number(cell.dataset.x) && y === Number(cell.dataset.y));
        cell.classList.toggle('preview-valid', isPreviewed && preview.valid);
        cell.classList.toggle('preview-invalid', isPreviewed && !preview.valid);
    }
}

function finishPlacement() {
    if (!dragState || !currentState || pendingPlacement) return;
    const preview = getPlacementPreview(currentState.ownShips, currentState);
    dragState = null;
    if (!preview.valid) {
        const ownBoard = document.querySelector('#ownBoard');
        for (const cell of ownBoard.querySelectorAll('.setup-cell')) {
            cell.classList.remove('preview-valid', 'preview-invalid');
        }
        showMessage(preview.lengthMatches
            ? 'Этот корабль пересекается с другим, стоит слишком близко или выходит за границу.'
            : `Проведи линию ровно по ${selectedLength} ${selectedLength === 1 ? 'клетке' : 'клеткам'}.`, true);
        return;
    }
    pendingPlacement = true;
    const ownBoard = document.querySelector('#ownBoard');
    for (const cell of ownBoard.querySelectorAll('.setup-cell')) {
        cell.classList.remove('preview-valid', 'preview-invalid');
    }
    showMessage('Сохраняю расстановку...');
    send({ type: 'placement', ships: [...currentState.ownShips, preview.cells] });
}

function renderBoard(element, kind, state) {
    const shots = kind === 'own' ? state.incomingShots : state.outgoingShots;
    const ships = kind === 'own' ? new Set(state.ownShips.flat().map(({ x, y }) => `${x},${y}`)) : new Set();
    const canShoot = kind === 'target' && state.status === 'playing' && state.turn === state.playerIndex;
    element.replaceChildren();
    for (let y = 0; y < state.boardSize; y += 1) {
        for (let x = 0; x < state.boardSize; x += 1) {
            const shot = shots.find((item) => item.x === x && item.y === y);
            const classes = [];
            if (ships.has(`${x},${y}`)) classes.push('ship');
            if (shot) classes.push(shot.blocked ? 'sunk-neighbor' : shot.hit ? 'hit' : 'miss');
            if (!canShoot) classes.push('disabled');
            const description = `${String.fromCharCode(65 + y)}${x + 1}${shot
                ? shot.blocked ? ', клетка вокруг потопленного корабля' : shot.hit ? ', попадание' : ', промах'
                : ''}`;
            element.append(makeCell(classes.join(' '), description,
                canShoot && !shot ? () => send({ type: 'shoot', x, y }) : null));
        }
    }
}

function renderGame(state) {
    lobbyView.hidden = true;
    gameView.hidden = false;
    document.querySelector('#roomLabel').textContent = state.roomId;
    document.querySelector('#playerOneName').textContent = state.players[0] || 'Игрок 1';
    document.querySelector('#playerTwoName').textContent = state.players[1] || 'Ожидание игрока';
    document.querySelector('#playerOneStatus').textContent = state.ready[0] ? 'Готов' : 'Расставляет корабли';
    document.querySelector('#playerTwoStatus').textContent = state.players[1]
        ? state.ready[1] ? 'Готов' : 'Расставляет корабли'
        : 'Не в комнате';
    document.querySelector('#opponentBoardLabel').textContent = state.players[1] || 'Ожидание игрока';
    renderEmptyBoard(document.querySelector('#setupEnemyBoard'), state.boardSize);

    const setupPanel = document.querySelector('#setupPanel');
    const playPanel = document.querySelector('#playPanel');
    setupPanel.hidden = state.status !== 'setup';
    playPanel.hidden = state.status !== 'playing' && state.status !== 'finished';
    const ownReady = state.ready[state.playerIndex];
    const yourTurn = state.status === 'playing' && state.turn === state.playerIndex;

    if (state.status === 'setup') {
        if (!ownReady && remainingShips(state.ownShips, selectedLength) === 0) {
            selectedLength = [4, 3, 2, 1].find((length) => remainingShips(state.ownShips, length) > 0) || 0;
        }
        document.querySelector('#gameTitle').textContent = ownReady ? 'Ждём соперника' : 'Расставь корабли';
        document.querySelector('#gameSubtitle').textContent = ownReady
            ? 'Твоя расстановка сохранена. Игра начнётся, когда второй игрок будет готов.'
            : 'Выбери корабль и протяни по клеткам линию нужной длины.';
        document.querySelector('#turnPill').textContent = ownReady ? 'ГОТОВ' : 'РАССТАНОВКА';
        document.querySelector('#turnPill').classList.remove('your-turn');
        document.querySelector('#fleetProgress').textContent = `${(state.ownShips || []).length} / 10 кораблей`;
        document.querySelector('#orientationButton').textContent = vertical
            ? 'Вертикально'
            : 'Горизонтально';
        document.querySelector('#orientationButton').setAttribute('aria-pressed', String(vertical));
        document.querySelector('#orientationButton').disabled = ownReady;
        document.querySelector('#undoButton').disabled = ownReady || !state.ownShips.length || pendingPlacement;
        document.querySelector('#readyButton').disabled = ownReady || !fleetIsComplete(state.ownShips) || pendingPlacement;
        document.querySelector('#readyButton').textContent = ownReady ? 'Ожидаем соперника...' : 'Готово';
        gameMessage.classList.remove('error');
        gameMessage.textContent = ownReady
            ? 'Расстановка сохранена. Ждём готовности соперника.'
            : fleetIsComplete(state.ownShips)
                ? 'Все корабли расставлены. Нажми «Готово», когда будешь готова.'
                : 'Проведи по клеткам линию длиной выбранного корабля.';
        renderShipChoices(state.ownShips, ownReady || pendingPlacement);
        renderSetupBoard(document.querySelector('#ownBoard'), state);
        return;
    }

    document.querySelector('#gameTitle').textContent = state.status === 'finished'
        ? (state.winner === state.playerIndex ? 'Ты победила!' : 'Партия окончена')
        : yourTurn ? 'Твой ход' : 'Ход соперника';
    document.querySelector('#gameSubtitle').textContent = state.status === 'finished'
        ? (state.winner === state.playerIndex ? 'Ты нашла все клетки флота соперника.' : 'Соперник нашёл все клетки твоего флота.')
        : yourTurn ? 'Выбери клетку на поле соперника.' : 'Жди выстрела соперника.';
    document.querySelector('#turnPill').textContent = state.status === 'finished'
        ? 'ИГРА ОКОНЧЕНА'
        : yourTurn ? 'ТВОЙ ХОД' : 'ХОД СОПЕРНИКА';
    document.querySelector('#turnPill').classList.toggle('your-turn', yourTurn);
    document.querySelector('#playMessage').textContent = state.status === 'finished'
        ? 'Чтобы сыграть снова, создай новую комнату.'
        : yourTurn ? 'Попадание даёт ещё один выстрел. Промах передаёт ход.' : 'Ход перейдёт к тебе, когда соперник промахнётся.';
    renderBoard(document.querySelector('#playOwnBoard'), 'own', state);
    renderBoard(document.querySelector('#targetBoard'), 'target', state);
}

function renderEmptyBoard(element, boardSize) {
    element.replaceChildren();
    for (let index = 0; index < boardSize * boardSize; index += 1) {
        element.append(makeCell('', 'Клетка поля соперника', null));
    }
}

document.querySelector('#createButton').addEventListener('click', () => startRoom('create'));
document.querySelector('#joinButton').addEventListener('click', () => startRoom('join'));
roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = roomCodeInput.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
});
document.querySelector('#orientationButton').addEventListener('click', () => {
    vertical = !vertical;
    if (dragState) dragState.endX = dragState.endY = undefined;
    if (currentState) renderGame(currentState);
});
document.querySelector('#undoButton').addEventListener('click', () => {
    if (!currentState?.ownShips.length || pendingPlacement) return;
    pendingPlacement = true;
    showMessage('Обновляю расстановку...');
    send({ type: 'placement', ships: currentState.ownShips.slice(0, -1) });
});
document.querySelector('#readyButton').addEventListener('click', () => {
    showMessage('Отправляю готовность...');
    send({ type: 'ready' });
});
document.querySelector('#copyCodeButton').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(currentRoom);
        document.querySelector('#copyCodeButton').textContent = 'Скопировано';
        setTimeout(() => { document.querySelector('#copyCodeButton').textContent = 'Скопировать код'; }, 1600);
    } catch (error) {
        showMessage(`Не удалось скопировать код: ${error.message}`, true);
    }
});
document.querySelector('#backButton').addEventListener('click', () => {
    currentRoom = null;
    currentState = null;
    gameView.hidden = true;
    lobbyView.hidden = false;
    lobbyMessage.textContent = '';
});

window.addEventListener('pointerup', finishPlacement);
window.addEventListener('pointercancel', () => {
    dragState = null;
    document.querySelectorAll('.setup-cell').forEach((cell) => cell.classList.remove('preview-valid', 'preview-invalid'));
});
window.addEventListener('online', () => {
    if (!socket || socket.readyState === WebSocket.CLOSED) connect();
});
window.addEventListener('beforeunload', () => socket?.close());

connect();
