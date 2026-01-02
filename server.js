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

// Конфигурация авиаударов
const AIRSTRIKES_CONFIG = {
    strike: { name: 'Штурмовики', count: 2, description: 'Линия 1x5 клеток' },
    bomb: { name: 'Бомбардировщики', count: 2, description: 'Квадрат 2x2 клетки' },
    recon: { name: 'Разведка', count: 1, description: 'Область 3x3 (без урона)' }
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

// Функции для работы с авиаударами
function getStrikeCells(centerIndex) {
    const row = Math.floor(centerIndex / 10);
    const col = centerIndex % 10;
    const cells = [];
    
    if (col < 2 || col > 7) return [];
    
    for (let i = -2; i <= 2; i++) {
        cells.push(row * 10 + (col + i));
    }
    
    return cells;
}

function getBombCells(topLeftIndex) {
    const row = Math.floor(topLeftIndex / 10);
    const col = topLeftIndex % 10;
    const cells = [];
    
    if (row > 8 || col > 8) return [];
    
    for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
            cells.push((row + dr) * 10 + (col + dc));
        }
    }
    
    return cells;
}

function getReconCells(centerIndex) {
    const row = Math.floor(centerIndex / 10);
    const col = centerIndex % 10;
    const cells = [];
    
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            const newRow = row + dr;
            const newCol = col + dc;
            if (newRow >= 0 && newRow < 10 && newCol >= 0 && newCol < 10) {
                cells.push(newRow * 10 + newCol);
            }
        }
    }
    
    return cells;
}

// Инициализация авиаударов для игрока
function initializeAirstrikes() {
    return {
        strike: AIRSTRIKES_CONFIG.strike.count,
        bomb: AIRSTRIKES_CONFIG.bomb.count,
        recon: AIRSTRIKES_CONFIG.recon.count
    };
}

io.on('connection', (socket) => {
    console.log(`✅ Новое подключение: ${socket.id}`);
    
    // Создание лобби
    socket.on('createLobby', (data) => {
        console.log(`🎮 Создание лобби от ${socket.id}:`, data);
        
        try {
            const lobbyId = generateLobbyId();
            const lobby = {
                id: lobbyId,
                name: data.name || 'Без названия',
                password: data.password || null,
                maxPlayers: 2,
                hostId: socket.id,
                players: [{
                    id: socket.id,
                    name: data.playerName || `Игрок_${socket.id.slice(0, 4)}`,
                    ready: false,
                    shipsReady: false,
                    isHost: true,
                    airstrikes: initializeAirstrikes()
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
                airstrikes: initializeAirstrikes()
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
    
    // Получение списка лобби
    socket.on('getLobbies', () => {
        const publicLobbies = Array.from(lobbies.values())
            .filter(lobby => !lobby.password && !lobby.gameStarted && lobby.players.length < lobby.maxPlayers)
            .map(lobby => ({
                id: lobby.id,
                name: lobby.name,
                players: lobby.players.length,
                maxPlayers: lobby.maxPlayers,
                hasPassword: !!lobby.password
            }));
        
        socket.emit('lobbyList', publicLobbies);
    });
    
    // Присоединение к лобби
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
            airstrikes: initializeAirstrikes()
        });
        
        // Сохраняем информацию об игроке
        players.set(socket.id, {
            id: socket.id,
            name: playerName,
            lobbyId: data.lobbyId,
            ready: false,
            shipsReady: false,
            airstrikes: initializeAirstrikes()
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
    
    // Установка статуса готовности в лобби
    socket.on('setReady', (isReady) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        // Обновляем статус игрока
        const playerInLobby = lobby.players.find(p => p.id === socket.id);
        if (playerInLobby) {
            playerInLobby.ready = isReady;
            player.ready = isReady;
        }
        
        console.log(`✅ Игрок ${player.name} ${isReady ? 'готов' : 'не готов'} в лобби`);
        
        // Уведомляем всех в лобби
        io.to(lobby.id).emit('playerReady', {
            playerId: socket.id,
            playerName: player.name,
            ready: isReady
        });
        
        // Если оба игрока в лобби готовы и их ровно 2
        if (lobby.players.length === 2) {
            const allReady = lobby.players.every(p => p.ready);
            if (allReady && !lobby.gameStarted) {
                console.log(`🚀 Оба игрока готовы в лобби ${lobby.id}`);
                
                // Начинаем игру
                lobby.gameStarted = true;
                
                // Определяем, кто ходит первым (случайно)
                const firstPlayerIndex = Math.floor(Math.random() * 2);
                lobby.currentTurn = lobby.players[firstPlayerIndex].id;
                
                // Отправляем игрокам информацию о начале игры
                lobby.players.forEach((player, index) => {
                    const playerSocket = io.sockets.sockets.get(player.id);
                    if (playerSocket) {
                        playerSocket.emit('gameStart', {
                            canMove: player.id === lobby.currentTurn,
                            playerNumber: index + 1,
                            opponentName: lobby.players.find(p => p.id !== player.id)?.name || 'Противник'
                        });
                    }
                });
                
                console.log(`🎮 Игра началась в лобби ${lobby.id}, первый ход у ${lobby.currentTurn}`);
            }
        }
    });
    
    // Игрок готов к битве (расставил корабли)
    socket.on('playerShipsReady', () => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || !lobby.gameStarted) return;
        
        console.log(`⚔️ Игрок ${player.name} готов к битве`);
        
        // Помечаем игрока как готового к битве
        player.shipsReady = true;
        const playerInLobby = lobby.players.find(p => p.id === socket.id);
        if (playerInLobby) {
            playerInLobby.shipsReady = true;
        }
        
        // Проверяем, все ли игроки готовы к битве
        const allShipsReady = lobby.players.every(p => {
            const pl = players.get(p.id);
            return pl && pl.shipsReady;
        });
        
        if (allShipsReady) {
            console.log(`🚀 Все игроки готовы к битве в лобби ${lobby.id}`);
            
            // Отправляем информацию об авиаударах
            lobby.players.forEach(player => {
                const playerSocket = io.sockets.sockets.get(player.id);
                if (playerSocket) {
                    playerSocket.emit('airstrikesInfo', {
                        airstrikes: player.airstrikes,
                        config: AIRSTRIKES_CONFIG
                    });
                }
            });
            
            // Отправляем обновление хода
            io.to(lobby.id).emit('turnUpdate', {
                currentTurn: lobby.currentTurn
            });
        }
    });
    
    // Ход в игре
    socket.on('makeMove', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || !lobby.gameStarted) return;
        
        // Проверяем, ход ли игрока
        if (lobby.currentTurn !== socket.id) {
            socket.emit('lobbyError', 'Сейчас не ваш ход!');
            return;
        }
        
        console.log(`🎯 Ход от ${player.name} в клетку ${data.index}`);
        
        // Пересылаем ход противнику
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (opponent) {
            socket.to(lobby.id).emit('enemyMove', {
                index: data.index,
                playerId: socket.id
            });
        }
    });
    
    // Авиаудар в игре
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
            config: AIRSTRIKES_CONFIG
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
    
    // Результат авиаудара
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
    
    // Результат выстрела
    socket.on('shotResult', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (!opponent) return;
        
        console.log(`🎯 Результат выстрела от ${player.name}:`, data);
        
        // Если попадание - ход остается у стрелявшего
        // Если промах - ход переходит противнику
        if (data.hit) {
            // При попадании ход остается у стрелявшего
            lobby.currentTurn = socket.id;
            
            // Отправляем результат стрелявшему
            socket.emit('shotResult', {
                index: data.index,
                hit: data.hit,
                killed: data.killed,
                coords: data.coords
            });
            
            // Отправляем противнику
            socket.to(lobby.id).emit('enemyShotResult', {
                index: data.index,
                hit: data.hit,
                killed: data.killed,
                coords: data.coords
            });
        } else {
            // При промахе ход переходит противнику
            lobby.currentTurn = opponent.id;
            
            // Отправляем результат стрелявшему
            socket.emit('shotResult', {
                index: data.index,
                hit: data.hit,
                killed: data.killed,
                coords: data.coords
            });
            
            // Отправляем противнику
            socket.to(lobby.id).emit('enemyShotResult', {
                index: data.index,
                hit: data.hit,
                killed: data.killed,
                coords: data.coords
            });
        }
        
        // Отправляем обновление хода
        io.to(lobby.id).emit('turnUpdate', {
            currentTurn: lobby.currentTurn
        });
        
        console.log(`🔄 Ход передан ${lobby.currentTurn === socket.id ? 'стрелявшему' : 'противнику'}`);
    });
    
    // Завершение игры
    socket.on('gameOver', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        console.log(`🏁 Игра окончена в лобби ${lobby.id}`);
        
        // Определяем победителя
        const winner = data.winner ? socket.id : lobby.players.find(p => p.id !== socket.id)?.id;
        
        io.to(lobby.id).emit('gameOver', {
            winner: winner,
            reason: 'игра завершена'
        });
        
        // Закрываем лобби через 30 секунд
        setTimeout(() => {
            if (lobbies.has(lobby.id)) {
                lobbies.delete(lobby.id);
                broadcastLobbyList();
                console.log(`🗑️ Лобби ${lobby.id} удалено после игры`);
            }
        }, 30000);
    });
    
    // Выход из лобби
    socket.on('leaveLobby', () => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        // Удаляем игрока из лобби
        lobby.players = lobby.players.filter(p => p.id !== socket.id);
        
        // Уведомляем других игроков
        socket.to(lobby.id).emit('playerLeft', {
            id: socket.id,
            name: player.name,
            reason: 'покинул лобби'
        });
        
        // Если лобби пустое, удаляем его
        if (lobby.players.length === 0) {
            lobbies.delete(lobby.id);
            console.log(`🗑️ Лобби ${lobby.id} удалено (пустое)`);
        }
        
        player.lobbyId = null;
        player.ready = false;
        player.shipsReady = false;
        
        socket.leave(lobby.id);
        
        // Рассылаем обновленный список лобби
        broadcastLobbyList();
        
        console.log(`👤 Игрок ${player.name} покинул лобби ${lobby.id}`);
    });
    
    // Выход из игры
    socket.on('leaveGame', () => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        // Удаляем лобби
        lobbies.delete(lobby.id);
        broadcastLobbyList();
        
        console.log(`👋 Игрок ${player.name} покинул игру в лобби ${lobby.id}`);
    });
    
    // Запуск игры (когда оба готовы в лобби)
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
                
                // Отправляем информацию об авиаударах
                playerSocket.emit('airstrikesInfo', {
                    airstrikes: player.airstrikes,
                    config: AIRSTRIKES_CONFIG
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
    ╔══════════════════════════════════════════╗
    ║     МОРСКОЙ БОЙ С АВИАУДАРАМИ          ║
    ╚══════════════════════════════════════════╝
    
    🚀 Сервер запущен на порту: ${PORT}
    🌐 WebSocket сервер готов
    ✈️  Авиаудары: Штурмовики (2), Бомбардировщики (2), Разведка (1)
    📡 Ожидаем подключений...
    `);
});
