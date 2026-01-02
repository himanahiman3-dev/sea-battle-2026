const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

app.use(express.static(__dirname));
app.use(express.json());

// Хранилище данных
const lobbies = new Map();
const players = new Map();

// Генератор ID лобби
function generateLobbyId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log(`✅ Новое подключение: ${socket.id}`);
    
    // Создание лобби - ИСПРАВЛЕНО
    socket.on('createLobby', (data) => {
        console.log(`🎮 Запрос на создание лобби от ${socket.id}:`, data);
        
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
                    shipsPlaced: false,
                    isHost: true
                }],
                gameStarted: false,
                placementsReady: 0,
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
            
            // Отправляем обновленный список лобби всем
            broadcastLobbyList();
            
        } catch (error) {
            console.error('Ошибка при создании лобби:', error);
            socket.emit('lobbyError', 'Ошибка при создании лобби');
        }
    });
    
    // Получение списка лобби - ИСПРАВЛЕНО
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
        
        console.log(`📋 Отправка списка лобби (${publicLobbies.length} доступно)`);
        socket.emit('lobbyList', publicLobbies);
    });
    
    // Присоединение к лобби - ИСПРАВЛЕНО
    socket.on('joinLobby', (data) => {
        console.log(`👥 Запрос на присоединение к лобби ${data.lobbyId} от ${socket.id}`);
        
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
            shipsPlaced: false,
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
        
        // Уведомляем всех в лобби
        io.to(data.lobbyId).emit('playerJoined', {
            id: socket.id,
            name: playerName,
            players: lobby.players
        });
        
        // Отправляем обновленное лобби присоединившемуся игроку
        socket.emit('lobbyJoined', lobby);
        
        broadcastLobbyList();
    });
    
    // Игрок готов (расставил корабли) - НОВАЯ ФУНКЦИЯ
    socket.on('playerReady', () => {
        const player = players.get(socket.id);
        if (!player || !player.lobbyId) return;
        
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby) return;
        
        // Находим игрока в лобби
        const playerInLobby = lobby.players.find(p => p.id === socket.id);
        if (playerInLobby) {
            playerInLobby.ready = true;
            player.ready = true;
            
            console.log(`✅ Игрок ${player.name} готов к игре`);
            
            // Уведомляем всех в лобби
            io.to(lobby.id).emit('playerReady', {
                playerId: socket.id,
                playerName: player.name,
                ready: true
            });
            
            // Проверяем, все ли игроки готовы
            const allReady = lobby.players.every(p => p.ready);
            const allPlayers = lobby.players.length === lobby.maxPlayers;
            
            if (allReady && allPlayers) {
                console.log(`🚀 Все игроки готовы в лобби ${lobby.id}`);
                
                // Определяем, кто ходит первым
                const firstPlayerIndex = Math.random() < 0.5 ? 0 : 1;
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
                        name: player.name
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
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║     МОРСКОЙ БОЙ - ЛОББИ v2.1         ║
    ╚═══════════════════════════════════════╝
    
    🚀 Сервер запущен на порту: ${PORT}
    🌐 WebSocket сервер готов
    📡 Ожидаем подключений...
    `);
});
