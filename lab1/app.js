const express = require('express');
const multer = require('multer');
const path = require('path');
const app = express();

app.set('view engine', 'ejs');

app.use(express.urlencoded({ extended: true })); 
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

let tasks = [];

app.get('/', (req, res) => {
    const filter = req.query.filter; 
    let filteredTasks = tasks;

    if (filter === 'done') {
        filteredTasks = tasks.filter(t => t.completed);
    } else if (filter === 'todo') {
        filteredTasks = tasks.filter(t => !t.completed);
    }

    res.render('index', { tasks: filteredTasks, currentFilter: filter });
});

app.post('/add', upload.single('taskFile'), (req, res) => {
    const newTask = {
        id: Date.now(),
        title: req.body.title,
        dueDate: req.body.dueDate,
        completed: false,
        file: req.file ? req.file.filename : null 
    };
    tasks.push(newTask);
    res.redirect('/'); 
});

app.post('/toggle/:id', (req, res) => {
    const task = tasks.find(t => t.id == req.params.id);
    if (task) task.completed = !task.completed;
    res.redirect('/');
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});