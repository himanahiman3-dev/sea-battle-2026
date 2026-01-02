const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Раздаем статические файлы
app.use(express.static(__dirname));
app.use(express.json());

// Хранилище лобби
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
    console.log(`🔥 Новый игрок подключился: ${socket.id}`);
    
    // Добавляем игрока в список
    players.set(socket.id, {
        id: socket.id,
        name: `Игрок_${socket.id.slice(0, 4)}`,
        lobbyId: null,
        ready: false
    });
    
    // Создание лобби
    socket.on('createLobby', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        const lobbyId = generateLobbyId();
        const lobby = {
            id: lobbyId,
            name: data.name,
            password: data.password,
            maxPlayers: data.maxPlayers || 2,
            isPrivate: data.isPrivate || false,
            hostId: socket.id,
            players: [{
                id: socket.id,
                name: data.playerName || player.name,
                ready: false,
                isHost: true
            }],
            gameStarted: false,
            createdAt: Date.now(),
            mode: 'classic'
        };
        
        lobbies.set(lobbyId, lobby);
        player.lobbyId = lobbyId;
        player.name = data.playerName || player.name;
        
        socket.join(lobbyId);
        socket.emit('lobbyCreated', lobby);
        
        console.log(`🎮 Лобби создано: ${lobbyId} (${lobby.name})`);
        
        // Отправляем обновленный список лобби всем
        broadcastLobbyList();
    });
    
    // Получение списка лобби
    socket.on('getLobbies', () => {
        const publicLobbies = Array.from(lobbies.values())
            .filter(lobby => !lobby.isPrivate && !lobby.gameStarted)
            .map(lobby => ({
                id: lobby.id,
                name: lobby.name,
                players: lobby.players.length,
                maxPlayers: lobby.maxPlayers,
                hasPassword: !!lobby.password,
                mode: lobby.mode
            }));
        
        socket.emit('lobbyList', publicLobbies);
    });
    
    // Присоединение к лобби
    socket.on('joinLobby', (data) => {
        const player = players.get(socket.id);
        if (!player) return;
        
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
        
        // Проверяем, не находится ли игрок уже в другом лобби
        if (player.lobbyId && player.lobbyId !== data.lobbyId) {
            leaveLobby(socket);
        }
        
        player.lobbyId = data.lobbyId;
        player.name = data.playerName || player.name;
        player.ready = false;
        
        // Добавляем игрока в лобби
        lobby.players.push({
            id: socket.id,
            name: player.name,
            ready: false,
            isHost: false
        });
        
        socket.join(data.lobbyId);
        socket.emit('lobbyJoined', lobby);
        
        // Уведомляем других игроков в лобби
        socket.to(data.lobbyId).emit('playerJoined', {
            id: socket.id,
            name: player.name
        });
        
        console.log(`👤 Игрок ${player.name} присоединился к лобби ${lobby.id}`);
        
        // Обновляем список лобби
        broadcastLobbyList();
    });
    
    // Выход из лобби
    socket.on('leaveLobby', () => {
        leaveLobby(socket);
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
        
        // Уведомляем всех в лобби
        io.to(lobby.id).emit('playerReady', {
            playerId: socket.id,
            playerName: player.name,
            ready: isReady
        });
        
        console.log(`✅ Игрок ${player.name} ${isReady ? 'готов' : 'не готов'}`);
    });
    
    // Начало игры
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
        
        // Проверяем, что все игроки готовы
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
        
        // Отправляем игрокам информацию о начале игры
        lobby.players.forEach(player => {
            const playerSocket = io.sockets.sockets.get(player.id);
            if (playerSocket) {
                playerSocket.emit('gameStart', {
                    canMove: player.id === firstPlayerId,
                    opponent: lobby.players.find(p => p.id !== player.id)?.name || 'Противник',
                    lobbyId: lobby.id
                });
            }
        });
        
        console.log(`🚀 Игра началась в лобби ${lobby.id}`);
        
        // Обновляем список лобби
        broadcastLobbyList();
    });
    
    // Ход в игре
    socket.on('makeMove', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || !lobby.gameStarted) return;
        
        // Пересылаем ход противнику
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (opponent) {
            socket.to(lobby.id).emit('enemyMove', {
                index: data.index,
                playerId: socket.id,
                playerName: player.name
            });
        }
        
        console.log(`🎯 Игрок ${player.name} сделал ход в клетку ${data.index}`);
    });
    
    // Результат выстрела
    socket.on('shotResult', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        // Пересылаем результат стрелявшему
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (opponent) {
            socket.to(lobby.id).emit('shotResult', data);
        }
    });
    
    // Сообщение в лобби
    socket.on('lobbyMessage', (text) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        io.to(lobby.id).emit('lobbyMessage', {
            sender: player.name,
            text: text
        });
    });
    
    // Сообщение в игре
    socket.on('gameMessage', (text) => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        io.to(lobby.id).emit('gameMessage', {
            sender: player.name,
            text: text
        });
    });
    
    // Завершение игры
    socket.on('gameOver', () => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        // Определяем победителя (тот, кто не сдался)
        const winner = lobby.players.find(p => p.id !== socket.id);
        
        io.to(lobby.id).emit('gameOver', {
            winner: winner?.id || null,
            reason: 'сдался'
        });
        
        // Закрываем лобби после игры
        setTimeout(() => {
            if (lobbies.has(lobby.id)) {
                lobbies.delete(lobby.id);
                broadcastLobbyList();
                console.log(`🗑️ Лобби ${lobby.id} удалено после игры`);
            }
        }, 30000);
    });
    
    // Выход из игры
    socket.on('leaveGame', () => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        // Уведомляем противника
        const opponent = lobby.players.find(p => p.id !== socket.id);
        if (opponent) {
            io.to(opponent.id).emit('playerLeft', {
                id: socket.id,
                name: player.name,
                reason: 'покинул игру'
            });
        }
        
        // Удаляем лобби
        lobbies.delete(lobby.id);
        broadcastLobbyList();
        
        console.log(`👋 Игрок ${player.name} покинул игру в лобби ${lobby.id}`);
    });
    
    // Отключение игрока
    socket.on('disconnect', () => {
        console.log(`👋 Игрок отключился: ${socket.id}`);
        leaveLobby(socket);
        players.delete(socket.id);
    });
    
    // Вспомогательные функции
    function leaveLobby(socket) {
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
        } else {
            // Если вышел хост, назначаем нового
            if (lobby.hostId === socket.id) {
                lobby.hostId = lobby.players[0].id;
                lobby.players[0].isHost = true;
            }
        }
        
        player.lobbyId = null;
        player.ready = false;
        
        socket.leave(lobby.id);
        
        // Обновляем список лобби
        broadcastLobbyList();
        
        console.log(`👤 Игрок ${player.name} покинул лобби ${lobby.id}`);
    }
    
    function broadcastLobbyList() {
        const publicLobbies = Array.from(lobbies.values())
            .filter(lobby => !lobby.isPrivate && !lobby.gameStarted)
            .map(lobby => ({
                id: lobby.id,
                name: lobby.name,
                players: lobby.players.length,
                maxPlayers: lobby.maxPlayers,
                hasPassword: !!lobby.password,
                mode: lobby.mode
            }));
        
        io.emit('lobbyList', publicLobbies);
    }
});

// Маршруты API
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/api/lobbies', (req, res) => {
    const publicLobbies = Array.from(lobbies.values())
        .filter(lobby => !lobby.isPrivate && !lobby.gameStarted)
        .map(lobby => ({
            id: lobby.id,
            name: lobby.name,
            players: lobby.players.length,
            maxPlayers: lobby.maxPlayers,
            hasPassword: !!lobby.password,
            mode: lobby.mode,
            createdAt: lobby.createdAt
        }));
    
    res.json({
        status: 'success',
        count: publicLobbies.length,
        lobbies: publicLobbies
    });
});

app.get('/api/stats', (req, res) => {
    res.json({
        status: 'online',
        players: players.size,
        lobbies: lobbies.size,
        activeGames: Array.from(lobbies.values()).filter(l => l.gameStarted).length,
        uptime: process.uptime()
    });
});

app.get('/api/lobby/:id', (req, res) => {
    const lobby = lobbies.get(req.params.id);
    if (!lobby) {
        return res.status(404).json({ error: 'Лобби не найдено' });
    }
    
    res.json({
        id: lobby.id,
        name: lobby.name,
        players: lobby.players.map(p => ({
            name: p.name,
            ready: p.ready,
            isHost: p.isHost
        })),
        maxPlayers: lobby.maxPlayers,
        gameStarted: lobby.gameStarted,
        createdAt: lobby.createdAt
    });
});

// Для Render
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║     МОРСКОЙ БОЙ - МУЛЬТИПЛЕЕР        ║
    ║         Система лобби v2.0           ║
    ╚═══════════════════════════════════════╝
    
    🚀 Сервер запущен на порту: ${PORT}
    🌐 WebSocket сервер готов
    📡 Ожидаем подключений...
    
    ✅ Статус: http://localhost:${PORT}/api/stats
    📋 Лобби: http://localhost:${PORT}/api/lobbies
    🎮 Игра: http://localhost:${PORT}/
    
    Функции:
    • Создание лобби с паролем
    • Публичный список лобби
    • Прямое подключение по ID
    • Чат в лобби и в игре
    • Голосование готовности
    • Автоматический старт игры
    `);
});

// Обработка ошибок
process.on('uncaughtException', (err) => {
    console.error('Необработанное исключение:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Необработанный промис:', promise, 'причина:', reason);
});
