const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`Пользователь подключился: ${socket.id}`);
    
    socket.on('joinCustomRoom', (data) => {
        console.log(`Попытка присоединения к комнате: ${data?.room}`);
        
        if (!data || !data.room || !data.pass) {
            socket.emit('errorMsg', 'Неверные данные для подключения');
            return;
        }
        
        const { room, pass } = data;

        if (!rooms.has(room)) {
            // Создание новой комнаты
            rooms.set(room, { 
                password: pass, 
                players: [socket.id],
                airstrikes: new Map(),
                gameState: {
                    started: false,
                    turn: null,
                    playerShips: new Map(),
                    playerMoves: new Map()
                }
            });
            
            socket.join(room);
            socket.roomName = room;
            socket.playerId = socket.id;
            
            console.log(`Комната ${room} создана пользователем ${socket.id}`);
            socket.emit('waiting', 'Комната создана. Ждем друга...');
        } else {
            // Присоединение к существующей комнате
            const currentRoom = rooms.get(room);
            
            if (currentRoom.password !== pass) {
                socket.emit('errorMsg', 'Неверный пароль!');
                return;
            }
            
            if (currentRoom.players.length >= 2) {
                socket.emit('errorMsg', 'Комната полна!');
                return;
            }

            currentRoom.players.push(socket.id);
            socket.join(room);
            socket.roomName = room;
            socket.playerId = socket.id;
            
            console.log(`Пользователь ${socket.id} присоединился к комнате ${room}`);
            io.to(room).emit('waiting', 'Противник вошел! Расставляйте флот.');
        }
    });

    socket.on('playerReady', () => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) {
            socket.emit('errorMsg', 'Комната не найдена');
            return;
        }

        socket.isReady = true;
        const currentRoom = rooms.get(roomName);
        
        // Получаем объекты сокетов для всех игроков комнаты
        const players = currentRoom.players
            .map(id => io.sockets.sockets.get(id))
            .filter(s => s && s.isReady);

        console.log(`Готовность в комнате ${roomName}: ${players.length}/2 игроков готовы`);

        if (players.length === 2) {
            // Инициализируем авиаудары для игроков
            currentRoom.airstrikes.set(players[0].id, true); // true - доступен
            currentRoom.airstrikes.set(players[1].id, true);
            
            // Определяем, кто ходит первым
            const first = Math.random() < 0.5 ? 0 : 1;
            currentRoom.gameState.turn = players[first].id;
            currentRoom.gameState.started = true;
            
            console.log(`Игра началась в комнате ${roomName}. Первый ход у: ${players[first].id}`);
            
            // Отправляем игрокам информацию о начале игры
            players[first].emit('gameStart', { 
                canMove: true,
                airstrikeAvailable: true 
            });
            
            players[1 - first].emit('gameStart', { 
                canMove: false,
                airstrikeAvailable: true 
            });
            
            io.to(roomName).emit('statusUpdate', 'Игра началась!');
        } else {
            const waitingPlayers = currentRoom.players
                .map(id => io.sockets.sockets.get(id))
                .filter(s => s);
                
            waitingPlayers.forEach(player => {
                if (player.id !== socket.id) {
                    player.emit('waiting', 'Противник готов! Ожидайте...');
                }
            });
            
            socket.emit('waiting', 'Ждем готовности врага...');
        }
    });

    socket.on('makeMove', (data) => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        
        // Проверяем, чей сейчас ход
        if (currentRoom.gameState.turn !== socket.id) {
            socket.emit('errorMsg', 'Сейчас не ваш ход!');
            return;
        }
        
        // Записываем ход
        if (!currentRoom.gameState.playerMoves.has(socket.id)) {
            currentRoom.gameState.playerMoves.set(socket.id, new Set());
        }
        
        const playerMoves = currentRoom.gameState.playerMoves.get(socket.id);
        
        // Проверяем, не стреляли ли уже в эту клетку
        if (playerMoves.has(data.index)) {
            socket.emit('errorMsg', 'Вы уже стреляли в эту клетку!');
            return;
        }
        
        playerMoves.add(data.index);
        
        console.log(`Ход от ${socket.id} в комнате ${roomName}: клетка ${data.index}`);
        
        // Передаем ход противнику
        socket.to(roomName).emit('enemyMove', {
            index: data.index,
            playerId: socket.id
        });
    });

    socket.on('shotResult', (data) => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        
        // Определяем, кто сейчас ходит (противник)
        const opponentId = currentRoom.players.find(id => id !== socket.id);
        const opponentSocket = io.sockets.sockets.get(opponentId);
        
        if (!opponentSocket) return;
        
        // Меняем ход в зависимости от результата
        if (data.hit && !data.killed) {
            // При попадании ход остается у того же игрока
            currentRoom.gameState.turn = opponentId;
            opponentSocket.emit('updateResult', {
                index: data.index,
                hit: true,
                killed: false,
                canMove: true
            });
            
            // Уведомляем стреляющего о результате
            socket.emit('updateResult', {
                index: data.index,
                hit: true,
                killed: false,
                canMove: false
            });
        } else if (data.hit && data.killed) {
            // При убийстве корабля ход тоже остается у того же игрока
            currentRoom.gameState.turn = opponentId;
            opponentSocket.emit('updateResult', {
                index: data.index,
                hit: true,
                killed: true,
                coords: data.coords,
                canMove: true
            });
            
            socket.emit('updateResult', {
                index: data.index,
                hit: true,
                killed: true,
                coords: data.coords,
                canMove: false
            });
        } else {
            // При промахе ход переходит другому игроку
            currentRoom.gameState.turn = socket.id;
            opponentSocket.emit('updateResult', {
                index: data.index,
                hit: false,
                killed: false,
                canMove: false
            });
            
            socket.emit('updateResult', {
                index: data.index,
                hit: false,
                killed: false,
                canMove: true
            });
        }
        
        // Отправляем обновление статуса
        io.to(roomName).emit('statusUpdate', `Ход игрока ${currentRoom.gameState.turn === socket.id ? socket.id : opponentId}`);
    });

    // Обработка авиаудара
    socket.on('airstrike', (data) => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        
        // Проверяем, чей сейчас ход
        if (currentRoom.gameState.turn !== socket.id) {
            socket.emit('errorMsg', 'Сейчас не ваш ход!');
            return;
        }
        
        // Проверяем, доступен ли авиаудар
        if (!currentRoom.airstrikes.get(socket.id)) {
            socket.emit('errorMsg', 'Авиаудар уже использован!');
            return;
        }
        
        // Проверяем, что цели находятся в пределах доски
        if (!data.targets || !Array.isArray(data.targets) || data.targets.length === 0) {
            socket.emit('errorMsg', 'Некорректные цели для авиаудара');
            return;
        }
        
        // Помечаем авиаудар как использованный
        currentRoom.airstrikes.set(socket.id, false);
        
        // Получаем сокет противника
        const opponentId = currentRoom.players.find(id => id !== socket.id);
        const opponentSocket = io.sockets.sockets.get(opponentId);
        
        if (!opponentSocket) {
            socket.emit('errorMsg', 'Противник не найден');
            return;
        }
        
        console.log(`Авиаудар от ${socket.id} в комнате ${roomName}. Центр: ${data.center}, целей: ${data.targets.length}`);
        
        // Отправляем цели противнику
        opponentSocket.emit('enemyAirstrike', {
            center: data.center,
            targets: data.targets,
            playerId: socket.id
        });
        
        // Подтверждаем использование авиаудара
        socket.emit('airstrikeConfirmed', { 
            used: true,
            targets: data.targets 
        });
        
        // Временно блокируем ходы до получения результатов авиаудара
        currentRoom.gameState.airstrikeInProgress = true;
        currentRoom.gameState.airstrikePlayer = socket.id;
    });

    // Результаты авиаудара от противника
    socket.on('airstrikeResult', (data) => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        const opponentId = currentRoom.players.find(id => id !== socket.id);
        const opponentSocket = io.sockets.sockets.get(opponentId);
        
        if (!opponentSocket) return;
        
        // Определяем, были ли попадания
        const hasHits = data.results.some(result => result.hit);
        
        // Если были попадания, то ход остается у игрока, который наносил авиаудар
        if (hasHits) {
            currentRoom.gameState.turn = opponentId;
            opponentSocket.emit('airstrikeResults', {
                results: data.results,
                canContinue: true
            });
            
            // Уведомляем о том, что ход продолжается
            io.to(roomName).emit('statusUpdate', 'Авиаудар нанес урон! Ход продолжается.');
        } else {
            // Если попаданий не было, ход переходит другому игроку
            currentRoom.gameState.turn = socket.id;
            opponentSocket.emit('airstrikeResults', {
                results: data.results,
                canContinue: false
            });
            
            // Уведомляем о промахе
            io.to(roomName).emit('statusUpdate', 'Авиаудар промахнулся! Ход переходит.');
        }
        
        // Снимаем блокировку ходов
        currentRoom.gameState.airstrikeInProgress = false;
        currentRoom.gameState.airstrikePlayer = null;
        
        console.log(`Результаты авиаудара в комнате ${roomName}: ${hasHits ? 'были попадания' : 'промах'}`);
    });

    // Обработка победы
    socket.on('gameWon', () => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;
        
        const currentRoom = rooms.get(roomName);
        const opponentId = currentRoom.players.find(id => id !== socket.id);
        const opponentSocket = io.sockets.sockets.get(opponentId);
        
        if (opponentSocket) {
            opponentSocket.emit('gameLost', 'Все ваши корабли уничтожены!');
        }
        
        io.to(roomName).emit('gameOver', { winner: socket.id });
        
        // Очищаем комнату через некоторое время
        setTimeout(() => {
            if (rooms.has(roomName)) {
                rooms.delete(roomName);
                console.log(`Комната ${roomName} удалена после завершения игры`);
            }
        }, 10000);
    });

    socket.on('disconnect', () => {
        console.log(`Пользователь отключился: ${socket.id}`);
        
        const roomName = socket.roomName;
        if (roomName && rooms.has(roomName)) {
            const currentRoom = rooms.get(roomName);
            
            // Удаляем игрока из комнаты
            currentRoom.players = currentRoom.players.filter(id => id !== socket.id);
            
            if (currentRoom.players.length === 0) {
                // Если комната пуста, удаляем ее
                rooms.delete(roomName);
                console.log(`Комната ${roomName} удалена (пуста)`);
            } else {
                // Уведомляем оставшегося игрока
                const remainingPlayer = currentRoom.players[0];
                const remainingSocket = io.sockets.sockets.get(remainingPlayer);
                
                if (remainingSocket) {
                    remainingSocket.emit('enemyDisconnected');
                }
                
                // Если игра началась, завершаем ее
                if (currentRoom.gameState.started) {
                    io.to(roomName).emit('gameOver', { 
                        winner: remainingPlayer,
                        reason: 'Противник отключился'
                    });
                }
                
                console.log(`Игрок ${socket.id} покинул комнату ${roomName}`);
            }
        }
    });

    // Обработка ошибок
    socket.on('error', (error) => {
        console.error(`Ошибка у пользователя ${socket.id}:`, error);
    });
});

// Маршрут для проверки состояния сервера
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        rooms: rooms.size,
        uptime: process.uptime()
    });
});

// Маршрут для получения списка комнат (для отладки)
app.get('/rooms', (req, res) => {
    const roomsInfo = {};
    
    for (const [roomName, room] of rooms.entries()) {
        roomsInfo[roomName] = {
            players: room.players.length,
            gameStarted: room.gameState.started
        };
    }
    
    res.json(roomsInfo);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📡 WebSocket сервер готов к подключениям`);
    console.log(`🌐 Откройте в браузере: http://localhost:${PORT}`);
});

// Обработка завершения работы сервера
process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    http.close(() => {
        console.log('✅ Сервер успешно остановлен');
        process.exit(0);
    });
});
