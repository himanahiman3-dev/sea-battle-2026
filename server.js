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

// Генератор ID лобби
function generateLobbyId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
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
                    isHost: true
                }],
                gameStarted: false,
                createdAt: Date.now()
            };
            
            lobbies.set(lobbyId, lobby);
            
            // Сохраняем информацию об игроке
            players.set(socket.id, {
                id: socket.id,
                name: data.playerName || `Игрок_${socket.id.slice(0, 4)}`,
                lobbyId: lobbyId,
                ready: false
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
            isHost: false
        });
        
        // Сохраняем информацию об игроке
        players.set(socket.id, {
            id: socket.id,
            name: playerName,
            lobbyId: data.lobbyId,
            ready: false
        });
        
        socket.join(data.lobbyId);
        
        console.log(`✅ Игрок ${playerName} присоединился к лобби ${lobby.id}`);
        
        // Уведомляем всех в лобби о новом игроке
        io.to(data.lobbyId).emit('playerJoined', {
            id: socket.id,
            name: playerName
        });
        
        // Отправляем обновленное лобби присоединившемуся игроку
        socket.emit('lobbyJoined', lobby);
        
        // Рассылаем обновленный список лобби
        broadcastLobbyList();
    });
    
    // Установка статуса готовности
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
        
        console.log(`✅ Игрок ${player.name} ${isReady ? 'готов' : 'не готов'}`);
        
        // Уведомляем всех в лобби
        io.to(lobby.id).emit('playerReady', {
            playerId: socket.id,
            playerName: player.name,
            ready: isReady
        });
        
        // Проверяем, все ли игроки готовы
        if (lobby.players.length === lobby.maxPlayers) {
            const allReady = lobby.players.every(p => p.ready);
            if (allReady) {
                console.log(`🚀 Все игроки готовы в лобби ${lobby.id}`);
                
                // Определяем, кто ходит первым
                const firstPlayerIndex = Math.floor(Math.random() * lobby.players.length);
                const firstPlayerId = lobby.players[firstPlayerIndex].id;
                
                lobby.gameStarted = true;
                
                // Отправляем игрокам информацию о начале игры
                lobby.players.forEach((player, index) => {
                    const playerSocket = io.sockets.sockets.get(player.id);
                    if (playerSocket) {
                        playerSocket.emit('gameStart', {
                            canMove: player.id === firstPlayerId,
                            playerNumber: index + 1,
                            opponentName: lobby.players.find(p => p.id !== player.id)?.name || 'Противник'
                        });
                    }
                });
                
                console.log(`🎮 Игра началась в лобби ${lobby.id}`);
            }
        }
    });
    
    // Игрок готов (расставил корабли и нажал "Начать битву")
    socket.on('playerReady', () => {
        // Эта функция уже есть выше, но под другим названием
        // Мы используем setReady для готовности в лобби
        // А здесь можно обработать готовность в игре
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        console.log(`⚔️ Игрок ${player.name} готов к битве`);
    });
    
    // Ход в игре
    socket.on('makeMove', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || !lobby.gameStarted) return;
        
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
    
    // Результат выстрела
    socket.on('shotResult', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        console.log(`🎯 Результат выстрела от ${player.name}:`, data);
        
        // Пересылаем результат стрелявшему
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (opponent) {
            socket.to(lobby.id).emit('shotResult', data);
        }
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
    ╔═══════════════════════════════════════╗
    ║     МОРСКОЙ БОЙ - ПОЛНАЯ ВЕРСИЯ     ║
    ╚═══════════════════════════════════════╝
    
    🚀 Сервер запущен на порту: ${PORT}
    🌐 WebSocket сервер готов
    📡 Ожидаем подключений...
    `);
});
