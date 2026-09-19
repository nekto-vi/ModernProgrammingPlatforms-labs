const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const db = new sqlite3.Database('./spa_tasks.db');

app.use(express.json()); 
app.use('/uploads', express.static('uploads'));
app.use(express.static('public')); 

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    dueDate TEXT,
    completed INTEGER DEFAULT 0,
    filename TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

app.get('/api/tasks', (req, res) => {
    db.all("SELECT * FROM tasks ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Ошибка базы данных" });
        res.status(200).json(rows);
    });
});

app.post('/api/tasks', upload.single('taskFile'), (req, res) => {
    const { title, dueDate } = req.body;
    
    if (!title || title.trim() === '') {
        return res.status(400).json({ error: "Название задачи обязательно!" }); 
    }

    const filename = req.file ? req.file.filename : null;

    db.run("INSERT INTO tasks (title, dueDate, filename) VALUES (?, ?, ?)", 
        [title.trim(), dueDate, filename], 
        function(err) {
            if (err) return res.status(500).json({ error: "Ошибка при сохранении" });
            
            db.get("SELECT * FROM tasks WHERE id = ?", [this.lastID], (err, row) => {
                res.status(201).json(row);
            });
        }
    );
});

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

app.delete('/api/tasks/:id', (req, res) => {
    const taskId = req.params.id;

    db.get("SELECT filename FROM tasks WHERE id = ?", [taskId], (err, row) => {
        if (row && row.filename) {
            fs.unlink('./uploads/' + row.filename, () => {});
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