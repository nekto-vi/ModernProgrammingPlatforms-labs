let tasks = [];
let currentFilter = 'all';
let currentUser = null;

const authPanel = document.getElementById('authPanel');
const appPanel = document.getElementById('appPanel');
const authMessage = document.getElementById('authMessage');
const taskForm = document.getElementById('taskForm');
const taskList = document.getElementById('taskList');
const errorAlert = document.getElementById('errorMessage');
const filterBtns = document.querySelectorAll('.filter-btn');

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[character]));
}

function canWrite() {
    return currentUser && ['admin', 'editor'].includes(currentUser.role);
}

async function apiRequest(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status === 401 && url !== '/api/auth/me') showAuth();
    if (!response.ok) {
        const error = new Error(data?.error?.message || 'Не удалось выполнить запрос.');
        error.status = response.status;
        error.code = data?.error?.code;
        throw error;
    }
    return data;
}

function showAuth(message = '') {
    currentUser = null;
    appPanel.hidden = true;
    authPanel.hidden = false;
    authMessage.textContent = message;
    authMessage.hidden = !message;
}

function showError(message) {
    errorAlert.textContent = message;
    errorAlert.style.display = 'block';
    setTimeout(hideError, 4000);
}

function hideError() {
    errorAlert.style.display = 'none';
}

async function initializeApp() {
    const token = new URLSearchParams(window.location.search).get('token');
    if (token) {
        try {
            await apiRequest('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            });
            window.history.replaceState({}, '', window.location.pathname);
        } catch (error) {
            window.history.replaceState({}, '', window.location.pathname);
            showAuth(error.message);
            return;
        }
    }

    try {
        const { user } = await apiRequest('/api/auth/me');
        currentUser = user;
        authPanel.hidden = true;
        appPanel.hidden = false;
        document.getElementById('currentEmail').textContent = user.email;
        document.getElementById('currentRole').textContent = {
            admin: 'Администратор',
            editor: 'Редактор',
            reader: 'Читатель'
        }[user.role] || user.role;
        taskForm.hidden = !canWrite();
        document.getElementById('adminPanel').hidden = user.role !== 'admin';
        await Promise.all([fetchTasks(), fetchSessions()]);
        if (user.role === 'admin') await fetchUsers();
    } catch (error) {
        if (error.status !== 401) showAuth(error.message);
    }
}

document.getElementById('requestLinkForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    authMessage.hidden = true;
    try {
        const email = document.getElementById('authEmail').value;
        const result = await apiRequest('/api/auth/request-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        authMessage.textContent = result.message;
        authMessage.hidden = false;
    } catch (error) {
        authMessage.textContent = error.message;
        authMessage.hidden = false;
    }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
        await apiRequest('/api/auth/logout', { method: 'POST' });
        showAuth('Вы вышли из системы.');
    } catch (error) {
        showError(error.message);
    }
});

document.getElementById('inviteForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
        await apiRequest('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: document.getElementById('inviteEmail').value,
                role: document.getElementById('inviteRole').value
            })
        });
        event.target.reset();
        showError('Приглашение отправлено.');
        await fetchUsers();
    } catch (error) {
        showError(error.message);
    }
});

document.getElementById('taskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();

    const title = document.getElementById('titleInput').value;
    const dueDate = document.getElementById('dateInput').value;
    const comment = document.getElementById('commentInput')?.value || '';
    const file = document.getElementById('fileInput').files[0];
    if (!title.trim()) return showError('Пожалуйста, введите название задачи.');

    const formData = new FormData();
    formData.append('title', title);
    formData.append('dueDate', dueDate);
    formData.append('comment', comment);
    if (file) formData.append('taskFile', file);

    try {
        await apiRequest('/api/tasks', { method: 'POST', body: formData });
        event.target.reset();
        clearFileSelection();
        await fetchTasks();
    } catch (error) {
        showError(error.message);
    }
});

async function fetchTasks() {
    const search = document.getElementById('searchInput')?.value || '';
    const sort = document.getElementById('sortSelect')?.value || 'created';
    try {
        tasks = await apiRequest(`/api/tasks?search=${encodeURIComponent(search)}&sort=${encodeURIComponent(sort)}`);
        renderTasks();
    } catch (error) {
        if (error.status !== 401) showError(error.message);
    }
}

async function fetchUsers() {
    try {
        const users = await apiRequest('/api/admin/users');
        const list = document.getElementById('usersList');
        list.replaceChildren();
        users.forEach((user) => {
            const row = document.createElement('div');
            row.className = 'management-row';
            const identity = document.createElement('span');
            identity.textContent = user.email;
            const select = document.createElement('select');
            select.className = 'main-input custom-select';
            select.setAttribute('aria-label', `Роль: ${user.email}`);
            [['reader', 'Читатель'], ['editor', 'Редактор'], ['admin', 'Администратор']].forEach(([role, label]) => {
                const option = document.createElement('option');
                option.value = role;
                option.textContent = label;
                option.selected = user.role === role;
                select.append(option);
            });
            select.disabled = user.id === currentUser.id;
            select.addEventListener('change', async () => {
                try {
                    await apiRequest(`/api/admin/users/${user.id}/role`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role: select.value })
                    });
                    await fetchUsers();
                } catch (error) {
                    showError(error.message);
                    await fetchUsers();
                }
            });
            row.append(identity, select);
            list.append(row);
        });
    } catch (error) {
        showError(error.message);
    }
}

async function fetchSessions() {
    try {
        const sessions = await apiRequest('/api/auth/sessions');
        const list = document.getElementById('sessionsList');
        list.replaceChildren();
        sessions.forEach((session) => {
            const row = document.createElement('div');
            row.className = 'management-row';
            const label = document.createElement('span');
            const createdAt = new Date(session.createdAt).toLocaleString('ru');
            label.textContent = `${session.userAgent || 'Устройство'} · ${createdAt}`;
            const action = session.current
                ? Object.assign(document.createElement('span'), { className: 'current-session', textContent: 'Текущая' })
                : Object.assign(document.createElement('button'), { className: 'secondary-btn', textContent: 'Отозвать', type: 'button' });
            if (!session.current) {
                action.addEventListener('click', async () => {
                    try {
                        await apiRequest(`/api/auth/sessions/${session.id}`, { method: 'DELETE' });
                        await fetchSessions();
                    } catch (error) {
                        showError(error.message);
                    }
                });
            }
            row.append(label, action);
            list.append(row);
        });
    } catch (error) {
        if (error.status !== 401) showError(error.message);
    }
}

async function toggleTaskStatus(id, currentStatus) {
    try {
        await apiRequest(`/api/tasks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: currentStatus === 1 ? 0 : 1 })
        });
        await fetchTasks();
    } catch (error) {
        showError(error.message);
    }
}

function startEditTask(task) {
    const card = document.getElementById(`task-${task.id}`);
    card.querySelector('.title-container').innerHTML = `<input type="text" id="edit-title-${task.id}" class="main-input" value="${escapeHTML(task.title)}">`;
    card.querySelector('.task-date').innerHTML = `Срок: <input type="date" id="edit-date-${task.id}" value="${escapeHTML(task.dueDate || '')}">`;
    const comment = card.querySelector('.task-comment');
    if (comment) comment.innerHTML = `Комментарий: <input type="text" id="edit-comment-${task.id}" class="main-input" value="${escapeHTML(task.comment || '')}">`;
    else {
        const newComment = document.createElement('div');
        newComment.className = 'task-comment';
        newComment.innerHTML = `Комментарий: <input type="text" id="edit-comment-${task.id}" class="main-input" value="">`;
        card.insertBefore(newComment, card.querySelector('.task-actions'));
    }
    const editButton = card.querySelector('.edit-btn-action');
    editButton.textContent = 'Сохранить';
    editButton.dataset.editing = 'true';
}

async function saveTask(task) {
    const title = document.getElementById(`edit-title-${task.id}`).value;
    const dueDate = document.getElementById(`edit-date-${task.id}`).value;
    const comment = document.getElementById(`edit-comment-${task.id}`).value;
    if (!title.trim()) return showError('Название не может быть пустым.');

    try {
        await apiRequest(`/api/tasks/${task.id}/full`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, dueDate, comment })
        });
        await fetchTasks();
    } catch (error) {
        showError(error.message);
    }
}

async function deleteTask(id) {
    if (!confirm('Вы уверены, что хотите удалить задачу?')) return;
    try {
        await apiRequest(`/api/tasks/${id}`, { method: 'DELETE' });
        await fetchTasks();
    } catch (error) {
        showError(error.message);
    }
}

function renderTasks() {
    taskList.replaceChildren();
    let filteredTasks = tasks;
    if (currentFilter === 'todo') filteredTasks = tasks.filter((task) => task.completed === 0);
    if (currentFilter === 'done') filteredTasks = tasks.filter((task) => task.completed === 1);

    if (!filteredTasks.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'Задач нет';
        taskList.append(empty);
        return;
    }

    filteredTasks.forEach((task) => {
        const isOverdue = task.completed === 0 && task.dueDate &&
            new Date(task.dueDate).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0);
        const card = document.createElement('article');
        card.id = `task-${task.id}`;
        card.className = `task-card ${task.completed ? 'done' : ''} ${isOverdue ? 'overdue-border' : ''}`;
        card.innerHTML = `
            <div class="task-header">
                <div class="title-container"><p class="task-title">${escapeHTML(task.title)}</p></div>
                ${isOverdue ? '<span class="badge-overdue">Просрочено</span>' : ''}
            </div>
            <div class="task-date">Срок: ${task.dueDate ? escapeHTML(new Date(task.dueDate).toLocaleDateString('ru')) : 'Нет даты'}</div>
            ${task.comment ? `<div class="task-comment">Комментарий: ${escapeHTML(task.comment)}</div>` : ''}
            ${task.filename ? `<a href="/uploads/${encodeURIComponent(task.filename)}" class="file-link">Скачать файл</a>` : ''}
        `;
        if (canWrite()) {
            const actions = document.createElement('div');
            actions.className = 'task-actions';
            actions.innerHTML = `
                <button class="status-btn toggle-btn" type="button">${task.completed ? 'Вернуть' : 'Выполнить'}</button>
                <button class="status-btn edit-btn-action" type="button">Изменить</button>
                <button class="status-btn delete-btn" type="button">Удалить</button>
            `;
            actions.querySelector('.toggle-btn').addEventListener('click', () => toggleTaskStatus(task.id, task.completed));
            actions.querySelector('.delete-btn').addEventListener('click', () => deleteTask(task.id));
            actions.querySelector('.edit-btn-action').addEventListener('click', (event) => {
                if (event.currentTarget.dataset.editing) saveTask(task);
                else startEditTask(task);
            });
            card.append(actions);
        }
        taskList.append(card);
    });
}

filterBtns.forEach((button) => button.addEventListener('click', (event) => {
    filterBtns.forEach((item) => item.classList.remove('active'));
    event.currentTarget.classList.add('active');
    currentFilter = event.currentTarget.dataset.filter;
    renderTasks();
}));

document.getElementById('searchInput').addEventListener('input', fetchTasks);
document.getElementById('sortSelect').addEventListener('change', fetchTasks);

function handleFileSelect(input) {
    if (!input.files?.length) return;
    document.getElementById('filePlaceholder').style.display = 'none';
    document.getElementById('fileInfo').style.display = 'flex';
    document.getElementById('fileName').textContent = input.files[0].name;
}

function clearFileSelection() {
    document.getElementById('fileInput').value = '';
    document.getElementById('filePlaceholder').style.display = 'inline-flex';
    document.getElementById('fileInfo').style.display = 'none';
}

window.handleFileSelect = handleFileSelect;
window.clearFileSelection = clearFileSelection;
initializeApp();