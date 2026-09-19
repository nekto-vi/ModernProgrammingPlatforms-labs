let tasks = [];
let currentFilter = 'all';

const taskForm = document.getElementById('taskForm');
const taskList = document.getElementById('taskList');
const errorAlert = document.getElementById('errorMessage');
const filterBtns = document.querySelectorAll('.filter-btn');

async function fetchTasks() {
    try {
        const response = await fetch('/api/tasks');
        if (!response.ok) throw new Error('Ошибка при загрузке задач');
        
        tasks = await response.json();
        renderTasks(); 
    } catch (err) {
        showError(err.message);
    }
}

taskForm.addEventListener('submit', async (e) => {
    e.preventDefault(); 
    hideError();

    const title = document.getElementById('titleInput').value;
    const dueDate = document.getElementById('dateInput').value;
    const file = document.getElementById('fileInput').files[0];

    if (!title.trim()) {
        return showError('Пожалуйста, введите название задачи!');
    }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('dueDate', dueDate);
    if (file) formData.append('taskFile', file);

    try {
        const response = await fetch('/api/tasks', {
            method: 'POST',
            body: formData 
        });

        const data = await response.json();

        if (response.status === 201) {
            tasks.unshift(data); 
            taskForm.reset();    
            renderTasks();       
        } else {
            showError(data.error); 
        }
    } catch (err) {
        showError('Ошибка сети');
    }
});

async function toggleTaskStatus(id, currentStatus) {
    const newStatus = currentStatus === 1 ? 0 : 1;

    try {
        const response = await fetch(`/api/tasks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ completed: newStatus })
        });

        if (response.ok) {
            const task = tasks.find(t => t.id === id);
            if (task) task.completed = newStatus;
            renderTasks();
        } else {
            const data = await response.json();
            showError(data.error);
        }
    } catch (err) {
        showError('Ошибка соединения с сервером');
    }
}

async function deleteTask(id) {
    if (!confirm('Вы уверены, что хотите удалить задачу?')) return;

    try {
        const response = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });

        if (response.ok) {
            tasks = tasks.filter(t => t.id !== id);
            renderTasks();
        } else {
            const data = await response.json();
            showError(data.error);
        }
    } catch (err) {
        showError('Ошибка при удалении');
    }
}

function renderTasks() {
    taskList.innerHTML = ''; 

    let filteredTasks = tasks;
    if (currentFilter === 'todo') filteredTasks = tasks.filter(t => t.completed === 0);
    if (currentFilter === 'done') filteredTasks = tasks.filter(t => t.completed === 1);

    if (filteredTasks.length === 0) {
        taskList.innerHTML = '<div style="text-align:center; color: gray;">Задач нет</div>';
        return;
    }

    filteredTasks.forEach(task => {
        const isOverdue = task.completed === 0 && new Date(task.dueDate).setHours(0,0,0,0) < new Date().setHours(0,0,0,0);
        
        const div = document.createElement('div');
        div.className = `task-card ${task.completed ? 'done' : ''} ${isOverdue ? 'overdue-border' : ''}`;
        
        div.innerHTML = `
            <div class="task-header">
                <p class="task-title">${task.title}</p>
                ${isOverdue ? '<span class="badge-overdue">Просрочено</span>' : ''}
            </div>
            <div class="task-date">🗓 Срок: ${task.dueDate ? new Date(task.dueDate).toLocaleDateString('ru') : 'Нет даты'}</div>
            
            ${task.filename ? `<a href="/uploads/${task.filename}" target="_blank" class="file-link">📎 Посмотреть файл</a>` : ''}
            
            <div style="display: flex; gap: 10px; margin-top: 10px;">
                <button onclick="toggleTaskStatus(${task.id}, ${task.completed})" class="status-btn">
                    ${task.completed ? '⏪ Вернуть' : '✅ Выполнить'}
                </button>
                <button onclick="deleteTask(${task.id})" class="status-btn" style="color: red;">🗑 Удалить</button>
            </div>
        `;
        taskList.appendChild(div);
    });
}

filterBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        filterBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        
        currentFilter = e.target.dataset.filter;
        renderTasks();
    });
});

function showError(msg) {
    errorAlert.textContent = msg;
    errorAlert.style.display = 'block';
    setTimeout(hideError, 4000); 
}

function hideError() {
    errorAlert.style.display = 'none';
}

function handleFileSelect(input) {
    if (input.files && input.files.length > 0) {
        document.getElementById('filePlaceholder').style.display = 'none';
        document.getElementById('fileInfo').style.display = 'flex';
        document.getElementById('fileName').textContent = '📎 ' + input.files[0].name;
    }
}

function clearFileSelection() {
    document.getElementById('fileInput').value = '';
    document.getElementById('filePlaceholder').style.display = 'inline-flex';
    document.getElementById('fileInfo').style.display = 'none';
}

fetchTasks();