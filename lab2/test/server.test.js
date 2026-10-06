const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bootstrapAdmin, createApp, initializeDatabase } = require('../server');

async function createHarness(options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lab2-auth-'));
    const uploadsDir = path.join(directory, 'uploads');
    fs.mkdirSync(uploadsDir);
    const db = new sqlite3.Database(':memory:');
    await initializeDatabase(db);
    await bootstrapAdmin(db, 'admin@example.test', () => {});

    const messages = [];
    const app = createApp({
        db,
        uploadsDir,
        authBaseUrl: 'http://localhost',
        mailer: { sendLoginLink: async (email, url) => messages.push({ email, url }) },
        logger: () => {},
        ...options
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    return {
        baseUrl,
        db,
        directory,
        messages,
        async close() {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    };
}

async function requestLink(harness, email) {
    const response = await fetch(`${harness.baseUrl}/api/auth/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
    });
    return response;
}

async function signIn(harness, email) {
    const requestResponse = await requestLink(harness, email);
    assert.equal(requestResponse.status, 202);
    const message = harness.messages.findLast((item) => item.email === email);
    assert.ok(message);
    const token = new URL(message.url).searchParams.get('token');
    const verifyResponse = await fetch(`${harness.baseUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
    });
    assert.equal(verifyResponse.status, 200);
    return { cookie: verifyResponse.headers.get('set-cookie').split(';')[0], token };
}

test('authentication, invitation roles, protected uploads, and session revocation', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());

    const anonymousTasks = await fetch(`${harness.baseUrl}/api/tasks`);
    assert.equal(anonymousTasks.status, 401);
    assert.equal((await anonymousTasks.json()).error.code, 'authentication_required');

    const admin = await signIn(harness, 'admin@example.test');
    const replay = await fetch(`${harness.baseUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: admin.token })
    });
    assert.equal(replay.status, 400);

    const inviteReader = await fetch(`${harness.baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.test', role: 'reader' })
    });
    assert.equal(inviteReader.status, 201);
    const readerUser = await inviteReader.json();
    const reader = await signIn(harness, 'reader@example.test');

    const readerTasks = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: reader.cookie } });
    assert.equal(readerTasks.status, 200);
    const forbiddenWrite = await fetch(`${harness.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { Cookie: reader.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Blocked task' })
    });
    assert.equal(forbiddenWrite.status, 403);
    assert.equal((await forbiddenWrite.json()).error.code, 'forbidden');
    const forbiddenAdmin = await fetch(`${harness.baseUrl}/api/admin/users`, { headers: { Cookie: reader.cookie } });
    assert.equal(forbiddenAdmin.status, 403);

    const changeOwnRole = await fetch(`${harness.baseUrl}/api/admin/users/1/role`, {
        method: 'PATCH',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader' })
    });
    assert.equal(changeOwnRole.status, 409);

    const inviteEditor = await fetch(`${harness.baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'editor@example.test', role: 'editor' })
    });
    assert.equal(inviteEditor.status, 201);
    const editor = await signIn(harness, 'editor@example.test');
    const createdTask = await fetch(`${harness.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { Cookie: editor.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Allowed task' })
    });
    assert.equal(createdTask.status, 201);
    const task = await createdTask.json();
    const changeRole = await fetch(`${harness.baseUrl}/api/admin/users/${readerUser.id}/role`, {
        method: 'PATCH',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'editor' })
    });
    assert.equal(changeRole.status, 200);

    const promotedWrite = await fetch(`${harness.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { Cookie: reader.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Role updated' })
    });
    assert.equal(promotedWrite.status, 201);

    const markDone = await fetch(`${harness.baseUrl}/api/tasks/${task.id}`, {
        method: 'PUT',
        headers: { Cookie: editor.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: 1 })
    });
    assert.equal(markDone.status, 200);

    fs.writeFileSync(path.join(harness.directory, 'uploads', 'private.txt'), 'private');
    const publicFile = await fetch(`${harness.baseUrl}/uploads/private.txt`);
    assert.equal(publicFile.status, 401);
    const protectedFile = await fetch(`${harness.baseUrl}/uploads/private.txt`, { headers: { Cookie: reader.cookie } });
    assert.equal(protectedFile.status, 200);
    assert.equal(protectedFile.headers.get('content-disposition'), 'attachment');
    assert.equal(protectedFile.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await protectedFile.text(), 'private');
    const missingFile = await fetch(`${harness.baseUrl}/uploads/missing.txt`, { headers: { Cookie: reader.cookie } });
    assert.equal(missingFile.status, 404);
    const missingFileBody = await missingFile.json();
    assert.equal(missingFileBody.error.code, 'resource_not_found');
    assert.equal(JSON.stringify(missingFileBody).includes(harness.directory), false);

    const sessionsResponse = await fetch(`${harness.baseUrl}/api/auth/sessions`, { headers: { Cookie: reader.cookie } });
    const [session] = await sessionsResponse.json();
    assert.equal(session.current, 1);
    const revokeResponse = await fetch(`${harness.baseUrl}/api/auth/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { Cookie: reader.cookie }
    });
    assert.equal(revokeResponse.status, 204);
    const revokedSession = await fetch(`${harness.baseUrl}/api/auth/me`, { headers: { Cookie: reader.cookie } });
    assert.equal(revokedSession.status, 401);
});

test('link requests do not reveal unknown users and enforce per-IP/email limits', async (t) => {
    const harness = await createHarness({ loginLimit: 2, rateWindowMs: 60000 });
    t.after(() => harness.close());

    const unknown = await requestLink(harness, 'not-found@example.test');
    assert.equal(unknown.status, 202);
    const unknownBody = await unknown.json();
    assert.match(unknownBody.message, /Если адрес зарегистрирован/);
    assert.equal(harness.messages.length, 0);

    const known = await requestLink(harness, 'admin@example.test');
    assert.equal(known.status, 202);
    assert.deepEqual(await known.json(), unknownBody);
    assert.equal(harness.messages.length, 1);

    const limited = await requestLink(harness, 'admin@example.test');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('malformed JSON and missing resources use the common error contract', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());

    const malformed = await fetch(`${harness.baseUrl}/api/auth/request-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{'
    });
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.error.code, 'invalid_json');
    assert.ok(malformedBody.error.requestId);

    const admin = await signIn(harness, 'admin@example.test');
    const missingTask = await fetch(`${harness.baseUrl}/api/tasks/999`, { headers: { Cookie: admin.cookie } });
    assert.equal(missingTask.status, 404);
    assert.equal((await missingTask.json()).error.code, 'route_not_found');
});

test('expired login links fail and verification attempts are rate limited', async (t) => {
    const harness = await createHarness({ verifyLimit: 2, rateWindowMs: 60000 });
    t.after(() => harness.close());

    await requestLink(harness, 'admin@example.test');
    const token = new URL(harness.messages[0].url).searchParams.get('token');
    await new Promise((resolve, reject) => harness.db.run(
        'UPDATE login_tokens SET expires_at = ? WHERE token_hash = ?',
        [new Date(Date.now() - 1000).toISOString(), require('../auth').hashToken(token)],
        (error) => error ? reject(error) : resolve()
    ));

    const verify = () => fetch(`${harness.baseUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
    });
    const expired = await verify();
    assert.equal(expired.status, 400);
    assert.equal((await expired.json()).error.code, 'invalid_token');
    assert.equal((await verify()).status, 400);
    const limited = await verify();
    assert.equal(limited.status, 429);
});

test('API routes handle requests without a JSON body as client errors', async (t) => {
    const harness = await createHarness();
    t.after(() => harness.close());

    const response = await fetch(`${harness.baseUrl}/api/auth/request-link`, { method: 'POST' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_email');
});