let tasks = [];
let currentFilter = 'all';

const taskForm = document.getElementById('taskForm');
const taskList = document.getElementById('taskList');
const errorAlert = document.getElementById('errorMessage');
const filterBtns = document.querySelectorAll('.filter-btn');

async function fetchTasks() {
    const searchVal = document.getElementById('searchInput') ? document.getElementById('searchInput').value : '';
    const sortVal = document.getElementById('sortSelect') ? document.getElementById('sortSelect').value : 'created';

    try {
        const response = await fetch(`/api/tasks?search=${encodeURIComponent(searchVal)}&sort=${sortVal}`);
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
    const comment = document.getElementById('commentInput') ? document.getElementById('commentInput').value : '';
    const file = document.getElementById('fileInput').files[0];

    if (!title.trim()) {
        return showError('Пожалуйста, введите название задачи!');
    }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('dueDate', dueDate);
    formData.append('comment', comment);
    if (file) formData.append('taskFile', file);

    try {
        const response = await fetch('/api/tasks', {
            method: 'POST',
            body: formData 
        });

        const data = await response.json();

        if (response.status === 201) {
            taskForm.reset();    
            clearFileSelection(); 
            fetchTasks(); 
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
            fetchTasks();
        } else {
            const data = await response.json();
            showError(data.error);
        }
    } catch (err) {
        showError('Ошибка соединения с сервером');
    }
}

function startEditTask(id, currentTitle, currentDueDate, currentComment) {
    const card = document.getElementById(`task-${id}`);
    const titleContainer = card.querySelector('.title-container');
    const dateContainer = card.querySelector('.task-date');
    const commentContainer = card.querySelector('.task-comment') || document.createElement('div');

    titleContainer.innerHTML = `
        <input type="text" id="edit-title-${id}" class="main-input" value="${currentTitle.replace(/"/g, '&quot;')}" style="padding: 6px; font-size: 1rem; margin-bottom: 6px;">
    `;
    
    dateContainer.innerHTML = `
        🗓 Срок: <input type="date" id="edit-date-${id}" value="${currentDueDate || ''}" style="padding: 4px; border-radius: 6px; border: 1px solid var(--border);">
    `;

    commentContainer.innerHTML = `
        💬 <input type="text" id="edit-comment-${id}" class="main-input" value="${(currentComment || '').replace(/"/g, '&quot;')}" placeholder="Добавить комментарий..." style="padding: 6px; font-size: 0.9rem; margin-top: 6px; margin-bottom: 0;">
    `;
    if (!card.querySelector('.task-comment')) {
        card.insertBefore(commentContainer, card.querySelector('.status-btn').parentNode);
    }
    commentContainer.className = 'task-comment';

    const editBtn = card.querySelector('.edit-btn-action');
    editBtn.textContent = '💾 Сохранить';
    editBtn.style.background = 'var(--primary)';
    editBtn.style.color = 'white';
}

async function saveTaskFull(id) {
    const newTitle = document.getElementById(`edit-title-${id}`).value;
    const newDueDate = document.getElementById(`edit-date-${id}`).value;
    const newComment = document.getElementById(`edit-comment-${id}`).value;

    if (!newTitle.trim()) {
        return showError('Название не может быть пустым!');
    }

    try {
        const response = await fetch(`/api/tasks/${id}/full`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle, dueDate: newDueDate, comment: newComment })
        });

        if (response.ok) {
            fetchTasks();
        } else {
            const data = await response.json();
            showError(data.error);
        }
    } catch (err) {
        showError('Ошибка при сохранении');
    }
}

async function deleteTask(id) {
    if (!confirm('Вы уверены, что хотите удалить задачу?')) return;

    try {
        const response = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });

        if (response.ok) {
            fetchTasks();
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
        const isOverdue = task.completed === 0 && task.dueDate && new Date(task.dueDate).setHours(0,0,0,0) < new Date().setHours(0,0,0,0);
        
        const div = document.createElement('div');
        div.id = `task-${task.id}`;
        div.className = `task-card ${task.completed ? 'done' : ''} ${isOverdue ? 'overdue-border' : ''}`;
        
        div.innerHTML = `
            <div class="task-header">
                <div class="title-container" style="flex-grow: 1;">
                    <p class="task-title">${task.title}</p>
                </div>
                ${isOverdue ? '<span class="badge-overdue">Просрочено</span>' : ''}
            </div>
            
            <div class="task-date">🗓 Срок: ${task.dueDate ? new Date(task.dueDate).toLocaleDateString('ru') : 'Нет даты'}</div>
            
            ${task.comment ? `<div class="task-comment" style="font-size: 0.9rem; color: var(--text-muted);">💬 ${task.comment}</div>` : ''}

            ${task.filename ? `<a href="/uploads/${task.filename}" target="_blank" class="file-link">📎 Посмотреть файл</a>` : ''}
            
            <div style="display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap;">
                <button class="status-btn toggle-btn" style="flex: 1;">
                    ${task.completed ? '⏪ Вернуть' : '✅ Выполнить'}
                </button>
                <button class="status-btn edit-btn-action" style="flex: 1;">
                    ✏️ Изменить
                </button>
                <button class="status-btn delete-btn" style="color: red; flex: 1;">
                    🗑 Удалить
                </button>
            </div>
        `;

        div.querySelector('.toggle-btn').addEventListener('click', () => toggleTaskStatus(task.id, task.completed));
        div.querySelector('.delete-btn').addEventListener('click', () => deleteTask(task.id));
        
        const editBtn = div.querySelector('.edit-btn-action');
        editBtn.addEventListener('click', () => {
            if (editBtn.textContent.includes('Изменить')) {
                startEditTask(task.id, task.title, task.dueDate || '', task.comment || '');
            } else {
                saveTaskFull(task.id);
            }
        });

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