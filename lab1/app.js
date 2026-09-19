const express = require('express');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const db = new sqlite3.Database('./tasks.db');

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); 
app.use('/uploads', express.static('uploads'));
app.use(express.static(__dirname));

db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    dueDate TEXT,
    completed INTEGER DEFAULT 0,
    filename TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.get('/', (req, res) => {
    const filter = req.query.filter;
    const searchQuery = req.query.search || ''; 

    let sql = "SELECT * FROM tasks WHERE title LIKE ?";
    let params = [`%${searchQuery}%`];

    if (filter === 'done') {
        sql += " AND completed = 1";
    } else if (filter === 'todo') {
        sql += " AND completed = 0";
    }

    sql += " ORDER BY created_at DESC";

    db.all(sql, params, (err, rows) => {
        res.render('index', { tasks: rows, currentFilter: filter, searchQuery });
    });
});

app.post('/add', upload.single('taskFile'), (req, res) => {
    const { title, dueDate } = req.body;
    const filename = req.file ? req.file.filename : null;
    
    db.run("INSERT INTO tasks (title, dueDate, filename) VALUES (?, ?, ?)", 
        [title, dueDate, filename], 
        () => res.redirect('/')
    );
});

app.post('/toggle/:id', (req, res) => {
    db.run("UPDATE tasks SET completed = NOT completed WHERE id = ?", [req.params.id], () => {
        res.redirect('/');
    });
});

app.post('/delete/:id', (req, res) => {
    db.run("DELETE FROM tasks WHERE id = ?", [req.params.id], () => {
        res.redirect('/');
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});