const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const dbPath = path.join(dataDir, 'spa_tasks.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка при открытии БД', err.message);
    } else {
        console.log('Подключено к базе данных SQLite.');
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            dueDate TEXT,
            comment TEXT,
            completed INTEGER DEFAULT 0,
            filename TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                console.error("Ошибка создания таблицы", err);
            } else {
                console.log("Таблица tasks успешно создана или уже существовала.");
            }
        });
    }
});

app.use(express.json()); 
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public'))); 

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.get('/api/tasks', (req, res) => {
    const search = req.query.search || '';
    const sort = req.query.sort;

    let orderBy = 'created_at DESC'; 
    if (sort === 'date_asc') {
        orderBy = 'dueDate ASC'; 
    } else if (sort === 'date_desc') {
        orderBy = 'dueDate DESC'; 
    } else if (sort === 'oldest') {
        orderBy = 'created_at ASC'; 
    }

    let sql = `SELECT * FROM tasks WHERE title LIKE ? ORDER BY ${orderBy}`;
    let params = [`%${search}%`];

    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: "Ошибка базы данных" });
        res.status(200).json(rows);
    });
});

app.post('/api/tasks', upload.single('taskFile'), (req, res) => {
    const { title, dueDate, comment } = req.body;
    
    if (!title || title.trim() === '') {
        return res.status(400).json({ error: "Название задачи обязательно!" }); 
    }

    const filename = req.file ? req.file.filename : null;

    db.run("INSERT INTO tasks (title, dueDate, comment, filename) VALUES (?, ?, ?, ?)", 
        [title.trim(), dueDate, comment, filename], 
        function(err) {
            if (err) return res.status(500).json({ error: "Ошибка при сохранении" });
            
            db.get("SELECT * FROM tasks WHERE id = ?", [this.lastID], (err, row) => {
                res.status(201).json(row);
            });
        }
    );
});

// 3. UPDATE STATUS (PUT)
app.put('/api/tasks/:id', (req, res) => {
    const taskId = req.params.id;
    const { completed } = req.body;

    if (completed === undefined) {
        return res.status(400).json({ error: "Не указан статус выполнения" });
    }

    db.run("UPDATE tasks SET completed = ? WHERE id = ?", [completed, taskId], function(err) {
        if (err) return res.status(500).json({ error: "Ошибка БД" });
        if (this.changes === 0) return res.status(404).json({ error: "Задача не найдена" }); 
        
        res.status(200).json({ message: "Статус обновлен" });
    });
});

app.put('/api/tasks/:id/full', (req, res) => {
    const taskId = req.params.id;
    const { title, dueDate, comment } = req.body;

    if (!title || title.trim() === '') {
        return res.status(400).json({ error: "Название не может быть пустым" });
    }

    db.run("UPDATE tasks SET title = ?, dueDate = ?, comment = ? WHERE id = ?", 
        [title.trim(), dueDate, comment, taskId], function(err) {
            if (err) return res.status(500).json({ error: "Ошибка БД" });
            if (this.changes === 0) return res.status(404).json({ error: "Задача не найдена" });

            res.status(200).json({ message: "Задача обновлена" });
        }
    );
});

app.delete('/api/tasks/:id', (req, res) => {
    const taskId = req.params.id;

    db.get("SELECT filename FROM tasks WHERE id = ?", [taskId], (err, row) => {
        if (row && row.filename) {
            fs.unlink(path.join(uploadsDir, row.filename), () => {});
        }
        
        db.run("DELETE FROM tasks WHERE id = ?", [taskId], function(err) {
            if (err) return res.status(500).json({ error: "Ошибка БД" });
            if (this.changes === 0) return res.status(404).json({ error: "Задача не найдена" });
            
            res.status(200).json({ message: "Задача удалена" });
        });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`REST API Сервер запущен на порту ${PORT}`);
});