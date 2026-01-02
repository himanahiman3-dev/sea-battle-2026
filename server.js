const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(__dirname));

// Хранилище данных
const lobbies = new Map();
const players = new Map();

// 1. КОНФИГУРАЦИЯ ИГРЫ (новый блок)
const GAME_CONFIG = {
    MAX_PLAYERS: 2,
    SHIP_LIMITS: { 4: 1, 3: 2, 2: 3, 1: 4 },
    // Конфигурация авиаударов
    AIRSTRIKES: {
        strike: { name: 'Штурмовики', count: 2, description: 'Линия 1x5 клеток' },
        bomb: { name: 'Бомбардировщики', count: 2, description: 'Квадрат 2x2 клетки' },
        recon: { name: 'Разведка', count: 1, description: 'Область 3x3 (без урона)' }
    },
    // Конфигурация бомб (для будущего использования в мультиплеере)
    BOMBS: {
        easy: 3,
        medium: 5,
        hard: 7,
        multiplayer: 5 // Стандартное количество бомб на игрока в мультиплеере
    }
};

// Генератор ID лобби
function generateLobbyId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}

// Инициализация авиаударов для игрока (вспомогательная функция)
function initializeAirstrikes() {
    return {
        strike: GAME_CONFIG.AIRSTRIKES.strike.count,
        bomb: GAME_CONFIG.AIRSTRIKES.bomb.count,
        recon: GAME_CONFIG.AIRSTRIKES.recon.count
    };
}

io.on('connection', (socket) => {
    console.log(`✅ Новое подключение: ${socket.id}`);

    // 2. ОТПРАВКА КОНФИГУРАЦИИ (новый обработчик)
    socket.on('getGameConfig', () => {
        socket.emit('gameConfig', GAME_CONFIG);
        console.log(`⚙️  Отправлена конфигурация игры для ${socket.id}`);
    });

    // Создание лобби (ваш существующий код, ДОПОЛНЕН)
    socket.on('createLobby', (data) => {
        console.log(`🎮 Создание лобби от ${socket.id}:`, data);

        try {
            const lobbyId = generateLobbyId();
            const lobby = {
                id: lobbyId,
                name: data.name || 'Без названия',
                password: data.password || null,
                maxPlayers: GAME_CONFIG.MAX_PLAYERS,
                hostId: socket.id,
                players: [{
                    id: socket.id,
                    name: data.playerName || `Игрок_${socket.id.slice(0, 4)}`,
                    ready: false,
                    shipsReady: false,
                    isHost: true,
                    airstrikes: initializeAirstrikes(), // Добавляем авиаудары
                    bombs: GAME_CONFIG.BOMBS.multiplayer // Добавляем бомбы
                }],
                gameStarted: false,
                currentTurn: null,
                createdAt: Date.now()
            };

            lobbies.set(lobbyId, lobby);

            // Сохраняем информацию об игроке
            players.set(socket.id, {
                id: socket.id,
                name: data.playerName || `Игрок_${socket.id.slice(0, 4)}`,
                lobbyId: lobbyId,
                ready: false,
                shipsReady: false,
                airstrikes: initializeAirstrikes(),
                bombs: GAME_CONFIG.BOMBS.multiplayer
            });

            socket.join(lobbyId);

            console.log(`✅ Лобби создано: ${lobbyId} (${lobby.name})`);

            // Отправляем подтверждение создателю
            socket.emit('lobbyCreated', lobby);

            // Рассылаем обновленный список лобби
            broadcastLobbyList();

        } catch (error) {
            console.error('Ошибка при создании лобби:', error);
            socket.emit('lobbyError', 'Ошибка при создании лобби');
        }
    });

    // Присоединение к лобби (ваш код, ДОПОЛНЕН)
    socket.on('joinLobby', (data) => {
        console.log(`👥 Присоединение к лобби ${data.lobbyId} от ${socket.id}`);

        const lobby = lobbies.get(data.lobbyId);
        if (!lobby) {
            socket.emit('lobbyError', 'Лобби не найдено');
            return;
        }

        if (lobby.password && lobby.password !== data.password) {
            socket.emit('lobbyError', 'Неверный пароль');
            return;
        }

        if (lobby.players.length >= lobby.maxPlayers) {
            socket.emit('lobbyError', 'Лобби заполнено');
            return;
        }

        if (lobby.gameStarted) {
            socket.emit('lobbyError', 'Игра уже началась');
            return;
        }

        // Добавляем игрока в лобби
        const playerName = data.playerName || `Игрок_${socket.id.slice(0, 4)}`;
        lobby.players.push({
            id: socket.id,
            name: playerName,
            ready: false,
            shipsReady: false,
            isHost: false,
            airstrikes: initializeAirstrikes(), // Добавляем авиаудары
            bombs: GAME_CONFIG.BOMBS.multiplayer // Добавляем бомбы
        });

        // Сохраняем информацию об игроке
        players.set(socket.id, {
            id: socket.id,
            name: playerName,
            lobbyId: data.lobbyId,
            ready: false,
            shipsReady: false,
            airstrikes: initializeAirstrikes(),
            bombs: GAME_CONFIG.BOMBS.multiplayer
        });

        socket.join(data.lobbyId);

        console.log(`✅ Игрок ${playerName} присоединился к лобби ${lobby.id}`);

        // Уведомляем всех в лобби о новом игроке
        io.to(data.lobbyId).emit('playerJoined', {
            id: socket.id,
            name: playerName,
            players: lobby.players
        });

        // Отправляем обновленное лобби присоединившемуся игроку
        socket.emit('lobbyJoined', lobby);

        // Рассылаем обновленный список лобби
        broadcastLobbyList();
    });

    // 3. ОБРАБОТЧИК АВИАУДАРА (новый блок)
    socket.on('airstrike', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || !lobby.gameStarted) return;

        // Проверяем, ход ли игрока
        if (lobby.currentTurn !== socket.id) {
            socket.emit('lobbyError', 'Сейчас не ваш ход!');
            return;
        }

        // Проверяем тип авиаудара
        const validTypes = ['strike', 'bomb', 'recon'];
        if (!validTypes.includes(data.type)) {
            socket.emit('lobbyError', 'Неверный тип авиаудара');
            return;
        }

        // Проверяем, есть ли еще доступные авиаудары этого типа
        if (player.airstrikes[data.type] <= 0) {
            socket.emit('lobbyError', 'Авиаудары этого типа закончились');
            return;
        }

        // Используем авиаудар
        player.airstrikes[data.type]--;

        // Обновляем авиаудары в лобби
        const playerInLobby = lobby.players.find(p => p.id === socket.id);
        if (playerInLobby) {
            playerInLobby.airstrikes[data.type]--;
        }

        console.log(`✈️ Авиаудар от ${player.name}: тип ${data.type}, клетка ${data.index}`);

        // Передаем ход противнику
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (opponent) {
            lobby.currentTurn = opponent.id;

            // Отправляем информацию об авиаударе противнику
            socket.to(lobby.id).emit('enemyAirstrike', {
                type: data.type,
                index: data.index,
                cells: data.cells, // Отправляем массив задетых клеток
                playerId: socket.id
            });
        }

        // Отправляем обновление хода
        io.to(lobby.id).emit('turnUpdate', {
            currentTurn: lobby.currentTurn
        });

        // Отправляем обновленную информацию об авиаударах
        socket.emit('airstrikesInfo', {
            airstrikes: player.airstrikes,
            config: GAME_CONFIG.AIRSTRIKES
        });

        // Отправляем противнику информацию об использовании авиаудара
        if (opponent) {
            const opponentSocket = io.sockets.sockets.get(opponent.id);
            if (opponentSocket) {
                opponentSocket.emit('enemyUsedAirstrike', {
                    type: data.type,
                    playerName: player.name
                });
            }
        }
    });

    // 4. РЕЗУЛЬТАТ АВИАУДАРА (новый обработчик)
    socket.on('airstrikeResult', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;

        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (!opponent) return;

        console.log(`🎯 Результат авиаудара от ${player.name}:`, data);

        // Отправляем результат противнику
        socket.to(lobby.id).emit('enemyAirstrikeResult', {
            type: data.type,
            cells: data.cells,
            hits: data.hits,
            killedShips: data.killedShips || []
        });
    });

    // 5. КАРКАС ДЛЯ БОМБ (новый обработчик)
    socket.on('bombHit', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || !lobby.gameStarted) return;

        console.log(`💣 Игрок ${player.name} активировал бомбу на клетке ${data.index}`);

        // Логика для бомб в мультиплеере будет здесь
        // Например, проверка, есть ли бомба у игрока, нанесение урона и синхронизация

        // Пока просто пересылаем информацию о взрыве противнику
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (opponent) {
            socket.to(lobby.id).emit('enemyBombExplosion', {
                index: data.index,
                playerId: socket.id
            });
        }
    });

    // Ваши существующие обработчики (setReady, playerShipsReady, makeMove, shotResult, gameOver и т.д.)
    // ... (оставьте ваш текущий код этих обработчиков без изменений) ...

    // В обработчик startGame добавим отправку конфигурации
    socket.on('startGame', () => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;

        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;

        // Проверяем, что игрок - хост
        if (lobby.hostId !== socket.id) {
            socket.emit('lobbyError', 'Только хост может начать игру');
            return;
        }

        // Проверяем, что оба игрока готовы
        const allReady = lobby.players.every(p => p.ready);
        if (!allReady) {
            socket.emit('lobbyError', 'Не все игроки готовы');
            return;
        }

        // Проверяем минимальное количество игроков
        if (lobby.players.length < 2) {
            socket.emit('lobbyError', 'Недостаточно игроков');
            return;
        }

        lobby.gameStarted = true;

        // Определяем, кто ходит первым (случайно)
        const firstPlayerIndex = Math.floor(Math.random() * lobby.players.length);
        const firstPlayerId = lobby.players[firstPlayerIndex].id;
        lobby.currentTurn = firstPlayerId;

        // Отправляем игрокам информацию о начале игры
        lobby.players.forEach((player, index) => {
            const playerSocket = io.sockets.sockets.get(player.id);
            if (playerSocket) {
                playerSocket.emit('gameStart', {
                    canMove: player.id === firstPlayerId,
                    playerNumber: index + 1,
                    opponentName: lobby.players.find(p => p.id !== player.id)?.name || 'Противник'
                });

                // Отправляем конфигурацию игры
                playerSocket.emit('gameConfig', GAME_CONFIG);

                // Отправляем информацию об авиаударах
                playerSocket.emit('airstrikesInfo', {
                    airstrikes: player.airstrikes,
                    config: GAME_CONFIG.AIRSTRIKES
                });
            }
        });

        console.log(`🎮 Игра началась в лобби ${lobby.id}, первый ход у ${firstPlayerId}`);

        // Рассылаем обновленный список лобби
        broadcastLobbyList();
    });

    // Отключение игрока
    socket.on('disconnect', () => {
        console.log(`❌ Отключение: ${socket.id}`);

        const player = players.get(socket.id);
        if (player && player.lobbyId) {
            const lobby = lobbies.get(player.lobbyId);
            if (lobby) {
                // Удаляем игрока из лобби
                lobby.players = lobby.players.filter(p => p.id !== socket.id);

                // Если лобби пустое, удаляем его
                if (lobby.players.length === 0) {
                    lobbies.delete(lobby.id);
                    console.log(`🗑️ Лобби ${lobby.id} удалено (пустое)`);
                } else {
                    // Уведомляем оставшихся игроков
                    io.to(lobby.id).emit('playerLeft', {
                        id: socket.id,
                        name: player.name,
                        reason: 'отключился'
                    });
                }

                broadcastLobbyList();
            }
        }

        players.delete(socket.id);
    });
});

// Функция рассылки списка лобби
function broadcastLobbyList() {
    const publicLobbies = Array.from(lobbies.values())
        .filter(lobby => !lobby.password && !lobby.gameStarted && lobby.players.length < lobby.maxPlayers)
        .map(lobby => ({
            id: lobby.id,
            name: lobby.name,
            players: lobby.players.length,
            maxPlayers: lobby.maxPlayers,
            hasPassword: !!lobby.password
        }));

    io.emit('lobbyList', publicLobbies);
}

// Маршруты
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        players: Array.from(players.keys()).length,
        lobbies: lobbies.size,
        activeGames: Array.from(lobbies.values()).filter(l => l.gameStarted).length,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════════════╗
    ║     МОРСКОЙ БОЙ С АВИАУДАРАМИ И БОМБАМИ     ║
    ╚══════════════════════════════════════════════╝

    🚀 Сервер запущен на порту: ${PORT}
    🌐 WebSocket сервер готов
    ✈️  Авиаудары: Штурмовики (2), Бомбардировщики (2), Разведка (1)
    💣 Бомбы: Готовы к интеграции в мультиплеер
    📡 Ожидаем подключений...
    `);
});
