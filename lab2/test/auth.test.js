const test = require('node:test');
const assert = require('node:assert/strict');
const { can, createRateLimiter, createToken, hashToken, parseCookies } = require('../auth');

test('temporary tokens are random and stored as irreversible hashes', () => {
    const first = createToken();
    const second = createToken();

    assert.equal(first.length, 64);
    assert.notEqual(first, second);
    assert.equal(hashToken(first), hashToken(first));
    assert.notEqual(hashToken(first), first);
});

test('roles grant only their intended permissions', () => {
    assert.equal(can('admin', 'users:manage'), true);
    assert.equal(can('editor', 'tasks:write'), true);
    assert.equal(can('reader', 'tasks:read'), true);
    assert.equal(can('reader', 'tasks:write'), false);
    assert.equal(can('unknown', 'tasks:read'), false);
});

test('rate limiter counts shared IP and email keys and resets after its window', () => {
    let now = 1000;
    const limit = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });

    assert.equal(limit(['ip:1', 'email:a']), 0);
    assert.equal(limit(['ip:1', 'email:a']), 0);
    assert.equal(limit(['ip:1', 'email:a']), 1);
    now = 2000;
    assert.equal(limit(['ip:1', 'email:a']), 0);
});

test('blocked requests do not consume counters for additional keys', () => {
    const limit = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 1000 });

    assert.equal(limit(['ip:1']), 0);
    assert.equal(limit(['ip:1', 'email:a']), 1);
    assert.equal(limit(['email:a']), 0);
    assert.equal(limit(['email:a']), 1);
});

test('cookie parser handles encoded values and malformed encoding', () => {
    assert.deepEqual(parseCookies('sid=a%20b; other=%E0%A4%A'), { sid: 'a b', other: '' });
});