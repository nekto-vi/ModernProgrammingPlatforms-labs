require('dotenv').config({ quiet: true });

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const {
    can,
    createRateLimiter,
    createToken,
    hashToken,
    parseCookies
} = require('./auth');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(ROOT, 'uploads');
const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_TOKEN_TTL_MS = 10 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(['admin', 'editor', 'reader']);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function log(level, event, fields = {}) {
    const entry = { timestamp: new Date().toISOString(), level, event, ...fields };
    const write = level === 'error' ? console.error : console.log;
    write(JSON.stringify(entry));
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) return reject(error);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function initializeDatabase(db) {
    return new Promise((resolve, reject) => {
        db.exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                dueDate TEXT,
                comment TEXT,
                completed INTEGER DEFAULT 0,
                filename TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'reader')),
                created_at TEXT NOT NULL,
                disabled_at TEXT
            );
            CREATE TABLE IF NOT EXISTS login_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                used_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                revoked_at TEXT,
                user_agent TEXT,
                ip_address TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        `, (error) => error ? reject(error) : resolve());
    });
}

async function bootstrapAdmin(db, email, logger = log) {
    if (!email) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) throw new Error('ADMIN_EMAIL is invalid');

    await run(db, `INSERT INTO users (email, role, created_at)
        VALUES (?, 'admin', ?) ON CONFLICT(email) DO UPDATE SET role = 'admin', disabled_at = NULL`,
    [normalizedEmail, new Date().toISOString()]);
    logger('info', 'bootstrap_admin_ready');
}

function createMailerFromEnv() {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
    if (!SMTP_HOST || !SMTP_FROM) return null;

    const port = Number(SMTP_PORT || 587);
    const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: port === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS || '' } : undefined
    });

    return {
        async sendLoginLink(email, url) {
            await transport.sendMail({
                from: SMTP_FROM,
                to: email,
                subject: 'Ссылка для входа',
                text: `Откройте ссылку для входа (действует 10 минут): ${url}`
            });
        }
    };
}

function createApp({
    db,
    uploadsDir = UPLOADS_DIR,
    mailer = createMailerFromEnv(),
    logger = log,
    secureCookies = process.env.NODE_ENV === 'production',
    authBaseUrl = process.env.AUTH_BASE_URL || 'http://localhost:3000',
    loginLimit = 5,
    verifyLimit = 10,
    inviteLimit = 10,
    rateWindowMs = 15 * 60 * 1000
}) {
    if (!db) throw new Error('A SQLite database connection is required');

    const app = express();
    const loginLimiter = createRateLimiter({ limit: loginLimit, windowMs: rateWindowMs });
    const verifyLimiter = createRateLimiter({ limit: verifyLimit, windowMs: rateWindowMs });
    const inviteLimiter = createRateLimiter({ limit: inviteLimit, windowMs: rateWindowMs });
    const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`;

    function sendError(res, requestId, status, code, message, extra = {}) {
        res.status(status).json({ error: { code, message, requestId, ...extra } });
    }

    function enforceLimit(limiter, keys, res) {
        const retryAfter = limiter(keys);
        if (!retryAfter) return false;
        res.set('Retry-After', String(retryAfter));
        sendError(res, res.locals.requestId, 429, 'rate_limited', 'Слишком много запросов. Попробуйте позже.');
        return true;
    }

    function clientIp(req) {
        return req.ip || req.socket.remoteAddress || 'unknown';
    }

    async function requireSession(req, res, next) {
        try {
            const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
            if (!cookie) return sendError(res, res.locals.requestId, 401, 'authentication_required', 'Требуется вход.');

            const session = await get(db, `SELECT s.id AS session_id, s.user_id, s.expires_at,
                u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.disabled_at IS NULL`, [hashToken(cookie)]);
            if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
                if (session) await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), session.session_id]);
                res.set('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions}; Max-Age=0`);
                return sendError(res, res.locals.requestId, 401, 'session_expired', 'Сессия завершена. Войдите снова.');
            }

            req.user = { id: session.user_id, email: session.email, role: session.role };
            req.sessionId = session.session_id;
            next();
        } catch (error) {
            next(error);
        }
    }

    function requirePermission(permission) {
        return (req, res, next) => {
            if (!can(req.user.role, permission)) {
                return sendError(res, res.locals.requestId, 403, 'forbidden', 'Недостаточно прав для этой операции.');
            }
            next();
        };
    }

    function createLoginToken(userId) {
        const token = createToken();
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + LOGIN_TOKEN_TTL_MS);
        return run(db, `INSERT INTO login_tokens (user_id, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?)`, [userId, hashToken(token), expiresAt.toISOString(), createdAt.toISOString()])
            .then(() => token);
    }

    app.use((req, res, next) => {
        const requestId = randomUUID();
        res.locals.requestId = requestId;
        res.set('X-Request-Id', requestId);
        const startedAt = Date.now();
        res.on('finish', () => logger('info', 'http_request', {
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - startedAt
        }));
        next();
    });
    app.use(express.json({ limit: '64kb' }));
    app.use((req, res, next) => {
        if (!req.body || typeof req.body !== 'object') req.body = {};
        next();
    });
    app.use(express.static(PUBLIC_DIR));

    app.post('/api/auth/request-link', async (req, res, next) => {
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!EMAIL_PATTERN.test(email)) return sendError(res, res.locals.requestId, 400, 'invalid_email', 'Укажите корректный email.');
        if (enforceLimit(loginLimiter, [`ip:${clientIp(req)}`, `email:${email}`], res)) return;
        if (!mailer) return sendError(res, res.locals.requestId, 503, 'mail_unavailable', 'Отправка писем не настроена.');

        try {
            const user = await get(db, 'SELECT id FROM users WHERE email = ? AND disabled_at IS NULL', [email]);
            if (user) {
                const token = await createLoginToken(user.id);
                const url = new URL('/', authBaseUrl);
                url.searchParams.set('token', token);
                Promise.resolve().then(() => mailer.sendLoginLink(email, url.toString())).catch((error) => {
                    logger('error', 'auth_email_delivery_failed', { requestId: res.locals.requestId, errorName: error.name });
                });
            }
            res.status(202).json({ message: 'Если адрес зарегистрирован, ссылка для входа будет отправлена.' });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/verify', async (req, res, next) => {
        if (enforceLimit(verifyLimiter, [`ip:${clientIp(req)}`], res)) return;
        const token = typeof req.body.token === 'string' ? req.body.token : '';
        if (!/^[a-f0-9]{64}$/.test(token)) return sendError(res, res.locals.requestId, 400, 'invalid_token', 'Ссылка недействительна или устарела.');

        try {
            const now = new Date().toISOString();
            const tokenRow = await get(db, `SELECT t.id, t.user_id FROM login_tokens t
                JOIN users u ON u.id = t.user_id
                WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.disabled_at IS NULL`,
            [hashToken(token), now]);
            if (!tokenRow) return sendError(res, res.locals.requestId, 400, 'invalid_token', 'Ссылка недействительна или устарела.');

            const consumed = await run(db, 'UPDATE login_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?',
                [now, tokenRow.id, now]);
            if (!consumed.changes) return sendError(res, res.locals.requestId, 400, 'invalid_token', 'Ссылка недействительна или устарела.');

            const sessionToken = createToken();
            const sessionId = randomUUID();
            const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
            await run(db, `INSERT INTO sessions
                (id, user_id, token_hash, created_at, expires_at, user_agent, ip_address)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                sessionId,
                tokenRow.user_id,
                hashToken(sessionToken),
                now,
                expiresAt,
                String(req.get('user-agent') || '').slice(0, 300),
                clientIp(req).slice(0, 80)
            ]);

            logger('info', 'auth_session_created', { requestId: res.locals.requestId, userId: tokenRow.user_id, sessionId });
            res.set('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; ${cookieOptions}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
            res.status(200).json({ message: 'Вход выполнен.' });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/auth/me', requireSession, (req, res) => {
        res.json({ user: req.user });
    });

    app.post('/api/auth/logout', requireSession, async (req, res, next) => {
        try {
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), req.sessionId]);
            logger('info', 'auth_session_revoked', { requestId: res.locals.requestId, userId: req.user.id, sessionId: req.sessionId });
            res.set('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions}; Max-Age=0`);
            res.status(204).end();
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/auth/sessions', requireSession, async (req, res, next) => {
        try {
            const sessions = await all(db, `SELECT id, created_at AS createdAt, expires_at AS expiresAt,
                user_agent AS userAgent, ip_address AS ipAddress, id = ? AS current
                FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
            [req.sessionId, req.user.id, new Date().toISOString()]);
            res.json(sessions);
        } catch (error) {
            next(error);
        }
    });

    app.delete('/api/auth/sessions/:id', requireSession, async (req, res, next) => {
        try {
            const result = await run(db, `UPDATE sessions SET revoked_at = ?
                WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
            [new Date().toISOString(), req.params.id, req.user.id]);
            if (!result.changes) return sendError(res, res.locals.requestId, 404, 'session_not_found', 'Сессия не найдена.');
            logger('info', 'auth_session_revoked', { requestId: res.locals.requestId, userId: req.user.id, sessionId: req.params.id });
            if (req.params.id === req.sessionId) res.set('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions}; Max-Age=0`);
            res.status(204).end();
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/admin/users', requireSession, requirePermission('users:manage'), async (req, res, next) => {
        try {
            const users = await all(db, `SELECT id, email, role, created_at AS createdAt, disabled_at AS disabledAt
                FROM users ORDER BY email`);
            res.json(users);
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/admin/users', requireSession, requirePermission('users:manage'), async (req, res, next) => {
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const role = req.body.role;
        if (!EMAIL_PATTERN.test(email) || !VALID_ROLES.has(role)) {
            return sendError(res, res.locals.requestId, 400, 'invalid_user', 'Укажите корректный email и роль.');
        }
        if (enforceLimit(inviteLimiter, [`ip:${clientIp(req)}`, `email:${email}`], res)) return;
        if (!mailer) return sendError(res, res.locals.requestId, 503, 'mail_unavailable', 'Отправка писем не настроена.');

        try {
            const createdAt = new Date().toISOString();
            const user = await run(db, 'INSERT INTO users (email, role, created_at) VALUES (?, ?, ?)', [email, role, createdAt]);
            const token = await createLoginToken(user.lastID);
            const url = new URL('/', authBaseUrl);
            url.searchParams.set('token', token);
            try {
                await mailer.sendLoginLink(email, url.toString());
            } catch (error) {
                logger('error', 'auth_email_delivery_failed', { requestId: res.locals.requestId, errorName: error.name });
                await run(db, 'DELETE FROM users WHERE id = ?', [user.lastID]);
                return sendError(res, res.locals.requestId, 502, 'email_delivery_failed', 'Не удалось отправить приглашение.');
            }
            logger('info', 'user_invited', { requestId: res.locals.requestId, actorId: req.user.id, userId: user.lastID, role });
            res.status(201).json({ id: user.lastID, email, role, createdAt });
        } catch (error) {
            if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
                return sendError(res, res.locals.requestId, 409, 'user_exists', 'Пользователь с таким email уже существует.');
            }
            next(error);
        }
    });

    app.patch('/api/admin/users/:id/role', requireSession, requirePermission('users:manage'), async (req, res, next) => {
        const userId = Number(req.params.id);
        const role = req.body.role;
        if (!Number.isSafeInteger(userId) || userId < 1 || !VALID_ROLES.has(role)) {
            return sendError(res, res.locals.requestId, 400, 'invalid_role', 'Укажите корректный идентификатор и роль.');
        }
        if (userId === req.user.id) return sendError(res, res.locals.requestId, 409, 'self_role_change', 'Нельзя изменить собственную роль.');

        try {
            const target = await get(db, 'SELECT id, role FROM users WHERE id = ? AND disabled_at IS NULL', [userId]);
            if (!target) return sendError(res, res.locals.requestId, 404, 'user_not_found', 'Пользователь не найден.');
            if (target.role === 'admin' && role !== 'admin') {
                const admins = await get(db, "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL");
                if (admins.count <= 1) return sendError(res, res.locals.requestId, 409, 'last_admin', 'В системе должен остаться хотя бы один администратор.');
            }
            await run(db, 'UPDATE users SET role = ? WHERE id = ?', [role, userId]);
            logger('info', 'user_role_changed', { requestId: res.locals.requestId, actorId: req.user.id, userId, role });
            res.json({ id: userId, role });
        } catch (error) {
            next(error);
        }
    });

    app.get('/uploads/:filename', requireSession, (req, res, next) => {
        const filename = path.basename(req.params.filename);
        res.sendFile(filename, {
            root: uploadsDir,
            dotfiles: 'deny',
            headers: {
                'Content-Disposition': 'attachment',
                'X-Content-Type-Options': 'nosniff'
            }
        }, (error) => error && next(error));
    });

    const storage = multer.diskStorage({
        destination: uploadsDir,
        filename: (req, file, callback) => {
            const extension = path.extname(file.originalname).toLowerCase();
            callback(null, `${createToken().slice(0, 32)}${extension}`);
        }
    });
    const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

    app.get('/api/tasks', requireSession, requirePermission('tasks:read'), async (req, res, next) => {
        const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';
        const orderBy = {
            date_asc: 'dueDate ASC',
            date_desc: 'dueDate DESC',
            oldest: 'created_at ASC'
        }[req.query.sort] || 'created_at DESC';

        try {
            const tasks = await all(db, `SELECT * FROM tasks WHERE title LIKE ? ORDER BY ${orderBy}`, [`%${search}%`]);
            res.json(tasks);
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/tasks', requireSession, requirePermission('tasks:write'), upload.single('taskFile'), async (req, res, next) => {
        const { title, dueDate, comment } = req.body;
        if (typeof title !== 'string' || !title.trim()) {
            if (req.file) fs.unlink(req.file.path, () => {});
            return sendError(res, res.locals.requestId, 400, 'title_required', 'Название задачи обязательно.');
        }

        try {
            const result = await run(db, `INSERT INTO tasks (title, dueDate, comment, filename)
                VALUES (?, ?, ?, ?)`, [title.trim(), dueDate || null, comment || null, req.file?.filename || null]);
            const task = await get(db, 'SELECT * FROM tasks WHERE id = ?', [result.lastID]);
            res.status(201).json(task);
        } catch (error) {
            if (req.file) fs.unlink(req.file.path, () => {});
            next(error);
        }
    });

    app.put('/api/tasks/:id', requireSession, requirePermission('tasks:write'), async (req, res, next) => {
        const taskId = Number(req.params.id);
        const { completed } = req.body;
        if (!Number.isSafeInteger(taskId) || taskId < 1 || ![0, 1, true, false].includes(completed)) {
            return sendError(res, res.locals.requestId, 400, 'invalid_task_update', 'Укажите корректный статус задачи.');
        }

        try {
            const result = await run(db, 'UPDATE tasks SET completed = ? WHERE id = ?', [Number(Boolean(completed)), taskId]);
            if (!result.changes) return sendError(res, res.locals.requestId, 404, 'task_not_found', 'Задача не найдена.');
            res.json({ message: 'Статус обновлен.' });
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/tasks/:id/full', requireSession, requirePermission('tasks:write'), async (req, res, next) => {
        const taskId = Number(req.params.id);
        const { title, dueDate, comment } = req.body;
        if (!Number.isSafeInteger(taskId) || taskId < 1 || typeof title !== 'string' || !title.trim()) {
            return sendError(res, res.locals.requestId, 400, 'invalid_task_update', 'Укажите корректные данные задачи.');
        }

        try {
            const result = await run(db, 'UPDATE tasks SET title = ?, dueDate = ?, comment = ? WHERE id = ?',
                [title.trim(), dueDate || null, comment || null, taskId]);
            if (!result.changes) return sendError(res, res.locals.requestId, 404, 'task_not_found', 'Задача не найдена.');
            res.json({ message: 'Задача обновлена.' });
        } catch (error) {
            next(error);
        }
    });

    app.delete('/api/tasks/:id', requireSession, requirePermission('tasks:write'), async (req, res, next) => {
        const taskId = Number(req.params.id);
        if (!Number.isSafeInteger(taskId) || taskId < 1) {
            return sendError(res, res.locals.requestId, 400, 'invalid_task_id', 'Некорректный идентификатор задачи.');
        }

        try {
            const task = await get(db, 'SELECT filename FROM tasks WHERE id = ?', [taskId]);
            if (!task) return sendError(res, res.locals.requestId, 404, 'task_not_found', 'Задача не найдена.');
            await run(db, 'DELETE FROM tasks WHERE id = ?', [taskId]);
            if (task.filename) fs.unlink(path.join(uploadsDir, path.basename(task.filename)), () => {});
            res.json({ message: 'Задача удалена.' });
        } catch (error) {
            next(error);
        }
    });

    app.use('/api', (req, res) => {
        sendError(res, res.locals.requestId, 404, 'route_not_found', 'Маршрут API не найден.');
    });

    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        let status = Number(error.status) || 500;
        let code = error.code || 'internal_error';
        let message = status >= 500 ? 'Внутренняя ошибка сервера.' : error.message;

        if (error.type === 'entity.parse.failed') {
            status = 400;
            code = 'invalid_json';
            message = 'Некорректный JSON.';
        } else if (error.code === 'ENOENT') {
            status = 404;
            code = 'resource_not_found';
            message = 'Ресурс не найден.';
        } else if (error instanceof multer.MulterError) {
            status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            code = error.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'invalid_upload';
            message = error.code === 'LIMIT_FILE_SIZE' ? 'Размер файла не должен превышать 10 МБ.' : 'Не удалось обработать файл.';
        }

        if (status >= 500) logger('error', 'http_error', {
            requestId: res.locals.requestId,
            errorName: error.name,
            errorCode: error.code
        });
        sendError(res, res.locals.requestId, status, code, message);
    });

    return app;
}

async function start() {
    const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'spa_tasks.db');
    const db = new sqlite3.Database(dbPath);
    await initializeDatabase(db);
    await bootstrapAdmin(db, process.env.ADMIN_EMAIL);

    const app = createApp({ db });
    const port = Number(process.env.PORT || 3000);
    const server = app.listen(port, () => log('info', 'server_started', { port }));
    return { app, db, server };
}

if (require.main === module) {
    start().catch((error) => {
        log('error', 'startup_failed', { errorName: error.name, errorCode: error.code });
        process.exitCode = 1;
    });
}

module.exports = { bootstrapAdmin, createApp, initializeDatabase, start };