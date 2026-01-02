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

// Хранилище комнат для мультиплеера
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`🔥 Новый игрок подключился: ${socket.id}`);
    
    // Присоединение к комнате для мультиплеера
    socket.on('joinCustomRoom', (data) => {
        if (!data || !data.room || !data.pass) {
            socket.emit('errorMsg', 'Введите ID комнаты и пароль');
            return;
        }
        
        const { room, pass } = data;
        const roomKey = room.trim().toLowerCase();

        if (!rooms.has(roomKey)) {
            // Создаем новую комнату
            rooms.set(roomKey, {
                password: pass,
                players: [socket.id],
                ready: [],
                gameState: {
                    started: false,
                    turn: null,
                    player1: socket.id,
                    player2: null
                }
            });
            
            socket.join(roomKey);
            socket.roomName = roomKey;
            
            socket.emit('waiting', 'Комната создана! Ждем второго игрока...');
            socket.emit('playerNumber', 1);
            
        } else {
            // Присоединяемся к существующей комнате
            const currentRoom = rooms.get(roomKey);
            
            if (currentRoom.password !== pass) {
                socket.emit('errorMsg', '❌ Неверный пароль!');
                return;
            }
            
            if (currentRoom.players.length >= 2) {
                socket.emit('errorMsg', '❌ Комната уже заполнена!');
                return;
            }

            // Добавляем второго игрока
            currentRoom.players.push(socket.id);
            currentRoom.gameState.player2 = socket.id;
            
            socket.join(roomKey);
            socket.roomName = roomKey;
            
            // Уведомляем обоих игроков
            socket.emit('playerNumber', 2);
            socket.emit('waiting', '✅ Оба игрока в комнате! Расставляйте корабли.');
            
            socket.to(roomKey).emit('opponentJoined');
            socket.to(roomKey).emit('waiting', '✅ Противник присоединился!');
        }
    });

    // Игрок готов к игре
    socket.on('playerReady', () => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;

        const currentRoom = rooms.get(roomName);
        
        if (!currentRoom.ready.includes(socket.id)) {
            currentRoom.ready.push(socket.id);
        }

        console.log(`🎯 Игрок ${socket.id} готов в комнате "${roomName}"`);

        // Если оба игрока готовы, начинаем игру
        if (currentRoom.players.length === 2 && 
            currentRoom.ready.length === 2 &&
            !currentRoom.gameState.started) {
            
            // Выбираем случайного игрока для первого хода
            const firstPlayerIndex = Math.random() < 0.5 ? 0 : 1;
            const firstPlayerId = currentRoom.players[firstPlayerIndex];
            const secondPlayerId = currentRoom.players[1 - firstPlayerIndex];
            
            currentRoom.gameState.turn = firstPlayerId;
            currentRoom.gameState.started = true;
            
            console.log(`🚀 Игра началась в комнате "${roomName}"`);
            
            // Отправляем игрокам информацию о начале игры
            io.to(firstPlayerId).emit('gameStart', { 
                canMove: true,
                message: '🎯 ВАШ ХОД! Атакуйте поле противника!'
            });
            
            io.to(secondPlayerId).emit('gameStart', { 
                canMove: false,
                message: '⏳ ХОД ПРОТИВНИКА...'
            });
        } else {
            // Уведомляем о готовности
            io.to(roomName).emit('waiting', 
                `Ожидание готовности... (${currentRoom.ready.length}/2 игроков готово)`);
        }
    });

    // Обычный ход в мультиплеере
    socket.on('makeMove', (data) => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        
        // Проверяем, ход ли игрока
        if (currentRoom.gameState.turn !== socket.id) {
            socket.emit('errorMsg', 'Сейчас не ваш ход!');
            return;
        }
        
        // Передаем ход противнику
        socket.to(roomName).emit('enemyMove', {
            index: data.index,
            playerId: socket.id
        });
    });

    // Результат выстрела в мультиплеере
    socket.on('shotResult', (data) => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        const opponentId = currentRoom.players.find(id => id !== socket.id);
        
        if (!opponentId) return;
        
        // Если попали, но не убили - ход остается у стрелявшего
        if (data.hit && !data.killed) {
            currentRoom.gameState.turn = opponentId;
            
            io.to(opponentId).emit('updateResult', {
                index: data.index,
                hit: true,
                killed: false,
                canMove: true
            });
            
        } else if (data.hit && data.killed) {
            // Убил корабль - ход тоже остается
            currentRoom.gameState.turn = opponentId;
            
            io.to(opponentId).emit('updateResult', {
                index: data.index,
                hit: true,
                killed: true,
                coords: data.coords,
                canMove: true
            });
            
        } else {
            // Промах - ход переходит
            currentRoom.gameState.turn = socket.id;
            
            io.to(opponentId).emit('updateResult', {
                index: data.index,
                hit: false,
                killed: false,
                canMove: false
            });
        }
    });

    // Игрок победил в мультиплеере
    socket.on('gameWon', () => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        const opponentId = currentRoom.players.find(id => id !== socket.id);
        
        if (opponentId) {
            io.to(opponentId).emit('gameLost');
        }
        
        io.to(roomName).emit('gameOver', { winner: socket.id });
        
        // Удаляем комнату через 30 секунд
        setTimeout(() => {
            if (rooms.has(roomName)) {
                rooms.delete(roomName);
            }
        }, 30000);
    });

    // Отключение игрока
    socket.on('disconnect', () => {
        const roomName = socket.roomName;
        if (roomName && rooms.has(roomName)) {
            const currentRoom = rooms.get(roomName);
            
            // Удаляем игрока из комнаты
            currentRoom.players = currentRoom.players.filter(id => id !== socket.id);
            currentRoom.ready = currentRoom.ready.filter(id => id !== socket.id);
            
            if (currentRoom.players.length === 0) {
                // Комната пуста - удаляем
                rooms.delete(roomName);
            } else {
                // Уведомляем оставшегося игрока
                io.to(currentRoom.players[0]).emit('enemyDisconnected');
                
                // Удаляем комнату через 30 секунд
                setTimeout(() => {
                    if (rooms.has(roomName)) {
                        rooms.delete(roomName);
                    }
                }, 30000);
            }
        }
    });
});

// Маршруты
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/status', (req, res) => {
    const activeRooms = Array.from(rooms.entries()).map(([name, room]) => ({
        name,
        players: room.players.length,
        started: room.gameState.started
    }));
    
    res.json({
        status: 'online',
        server: 'Sea Battle AI',
        version: '3.0.0',
        uptime: process.uptime(),
        players: io.engine.clientsCount,
        rooms: rooms.size,
        activeRooms: activeRooms
    });
});

app.get('/stats', (req, res) => {
    // Примерная статистика сервера
    const stats = {
        totalGames: 0,
        aiWins: 0,
        playerWins: 0,
        averageMoves: 0
    };
    
    res.json(stats);
});

// Для Render важно слушать правильный порт
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║      МОРСКОЙ БОЙ С ИИ v3.0           ║
    ║        Уровни сложности              ║
    ╚═══════════════════════════════════════╝
    
    🚀 Сервер запущен на порту: ${PORT}
    🌐 WebSocket сервер готов
    📡 Ожидаем подключений...
    
    ✅ Статус: http://localhost:${PORT}/status
    🎮 Игра: http://localhost:${PORT}/
    
    Уровни ИИ:
    🟢 Легкий   - случайные ходы
    🟡 Средний  - базовая стратегия
    🔴 Сложный  - продвинутый алгоритм
    `);
});

// Обработка ошибок
process.on('uncaughtException', (err) => {
    console.error('Необработанное исключение:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Необработанный промис:', promise, 'причина:', reason);
});
