const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

// Хранилище активных комнат: { roomId: { password, players: [] } }
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`Подключен: ${socket.id}`);

    socket.on('joinCustomRoom', (data) => {
        const { room, pass } = data;
        
        // Если комнаты нет - создаем
        if (!rooms.has(room)) {
            rooms.set(room, { 
                password: pass, 
                players: [socket.id] 
            });
            socket.join(room);
            socket.roomName = room;
            socket.emit('waiting', 'Комната создана. Ждем друга...');
            console.log(`Комната ${room} создана`);
        } else {
            const currentRoom = rooms.get(room);
            
            // Проверка пароля
            if (currentRoom.password !== pass) {
                return socket.emit('errorMsg', 'Неверный пароль!');
            }

            // Проверка на количество игроков (макс 2)
            if (currentRoom.players.length >= 2) {
                return socket.emit('errorMsg', 'Комната уже полна!');
            }

            // Вход в комнату
            currentRoom.players.push(socket.id);
            socket.join(room);
            socket.roomName = room;
            
            io.to(room).emit('waiting', 'Противник вошел! Расставляйте флот.');
            console.log(`Игрок ${socket.id} вошел в ${room}`);
        }
    });

    socket.on('playerReady', () => {
        const roomName = socket.roomName;
        if (!roomName || !rooms.has(roomName)) return;

        socket.isReady = true;
        const currentRoom = rooms.get(roomName);
        
        // Получаем объекты сокетов всех игроков в комнате
        const players = currentRoom.players.map(id => io.sockets.sockets.get(id)).filter(s => s);

        if (players.length === 2) {
            const allReady = players.every(p => p.isReady);
            if (allReady) {
                // Случайно выбираем, кто ходит первым (0 или 1)
                const first = Math.random() < 0.5 ? 0 : 1;
                const second = first === 0 ? 1 : 0;

                players[first].emit('gameStart', { canMove: true });
                players[second].emit('gameStart', { canMove: false });
                
                console.log(`Игра началась в комнате ${roomName}`);
            } else {
                socket.emit('waiting', 'Ждем, пока враг закончит расстановку...');
            }
        }
    });

    socket.on('makeMove', (data) => {
        if (socket.roomName) {
            // Отправляем строго второму игроку в комнате
            socket.to(socket.roomName).emit('enemyMove', data);
        }
    });

    socket.on('shotResult', (data) => {
        if (socket.roomName) {
            // Возвращаем результат стрелявшему
            socket.to(socket.roomName).emit('updateResult', data);
        }
    });

    socket.on('disconnect', () => {
        const roomName = socket.roomName;
        if (roomName && rooms.has(roomName)) {
            const currentRoom = rooms.get(roomName);
            
            // Удаляем игрока из списка комнаты
            currentRoom.players = currentRoom.players.filter(id => id !== socket.id);
            
            // Если в комнате никого не осталось - удаляем комнату из памяти
            if (currentRoom.players.length === 0) {
                rooms.delete(roomName);
                console.log(`Комната ${roomName} удалена (пуста)`);
            } else {
                // Если кто-то остался - уведомляем его
                io.to(roomName).emit('waiting', 'Противник покинул игру.');
                io.to(roomName).emit('enemyDisconnected'); // Можно добавить в клиент для сброса игры
            }
        }
        console.log(`Отключен: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`СЕРВЕР 2026: http://localhost:${PORT}`);
});
