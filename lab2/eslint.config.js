const nodeGlobals = {
    __dirname: 'readonly',
    Buffer: 'readonly',
    console: 'readonly',
    fetch: 'readonly',
    module: 'readonly',
    process: 'readonly',
    require: 'readonly',
    URL: 'readonly'
};

const browserGlobals = {
    confirm: 'readonly',
    document: 'readonly',
    fetch: 'readonly',
    FormData: 'readonly',
    setTimeout: 'readonly',
    URLSearchParams: 'readonly',
    window: 'readonly'
};

module.exports = [
    {
        files: ['**/*.js'],
        ignores: ['node_modules/**'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: nodeGlobals
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
        }
    },
    {
        files: ['public/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: browserGlobals
        }
    }
];