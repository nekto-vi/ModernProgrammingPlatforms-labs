const { createHash, randomBytes } = require('node:crypto');

const ROLE_PERMISSIONS = {
    admin: new Set(['tasks:read', 'tasks:write', 'users:manage']),
    editor: new Set(['tasks:read', 'tasks:write']),
    reader: new Set(['tasks:read'])
};

function createToken() {
    return randomBytes(32).toString('hex');
}

function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
    return Object.fromEntries(header.split(';').map((part) => {
        const separator = part.indexOf('=');
        if (separator < 0) return ['', ''];

        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            return [name, decodeURIComponent(value)];
        } catch {
            return [name, ''];
        }
    }).filter(([name]) => name));
}

function can(role, permission) {
    return ROLE_PERMISSIONS[role]?.has(permission) || false;
}

function createRateLimiter({ limit = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    const buckets = new Map();

    return (keys) => {
        const currentTime = now();
        const uniqueKeys = [...new Set(keys.filter(Boolean))];
        let retryAfterMs = 0;

        if (buckets.size > 10000) {
            for (const [key, bucket] of buckets) {
                if (currentTime >= bucket.resetAt) buckets.delete(key);
            }
        }

        for (const key of uniqueKeys) {
            const bucket = buckets.get(key);
            if (bucket && currentTime < bucket.resetAt && bucket.count >= limit) {
                retryAfterMs = Math.max(retryAfterMs, bucket.resetAt - currentTime);
            }
        }

        if (retryAfterMs > 0) return Math.ceil(retryAfterMs / 1000);

        for (const key of uniqueKeys) {
            const bucket = buckets.get(key);
            if (!bucket || currentTime >= bucket.resetAt) {
                buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
            } else {
                bucket.count += 1;
            }
        }

        return 0;
    };
}

module.exports = {
    ROLE_PERMISSIONS,
    can,
    createRateLimiter,
    createToken,
    hashToken,
    parseCookies
};