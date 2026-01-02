function executeAirstrike(centerIdx) {
    if (!airstrikeMode) return;
    
    const row = Math.floor(centerIdx / 10);
    const col = centerIdx % 10;
    const targets = [];
    
    // Собираем все клетки в радиусе 3x3
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            const nr = row + dr;
            const nc = col + dc;
            
            if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10) {
                const idx = nr * 10 + nc;
                const cell = document.getElementById(`enemy-${idx}`);
                
                // Проверяем, не стреляли ли уже в эту клетку
                if (!cell.classList.contains('hit') && !cell.classList.contains('miss')) {
                    targets.push(idx);
                }
            }
        }
    }
    
    if (targets.length === 0) {
        status.innerText = 'Все клетки в радиусе уже обстреляны!';
        airstrikeMode = false;
        airstrikeBtn.classList.remove('active');
        return;
    }
    
    // Отправляем запрос на авиаудар
    socket.emit('airstrike', { 
        center: centerIdx,
        targets: targets 
    });
    
    // Визуализация предварительного обстрела
    targets.forEach(idx => {
        const cell = document.getElementById(`enemy-${idx}`);
        cell.style.boxShadow = '0 0 10px 2px #FF9800';
    });
    
    airstrikeMode = false;
    airstrikeBtn.classList.remove('active');
    status.innerText = 'Авиаудар выполняется...';
}
