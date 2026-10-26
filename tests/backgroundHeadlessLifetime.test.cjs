const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the installed provider that Metro actually bundles, plus its TS source.
for (const relative of ['build/TaskManager.js', 'src/TaskManager.ts']) {
    test(`headless keep-alive waits for native completion: ${relative}`, async () => {
        const text = fs.readFileSync(path.join(__dirname, '../node_modules/expo-task-manager', relative), 'utf8');
        const start = text.indexOf("if (Platform.OS === 'android')");
        assert.ok(start >= 0);
        const end = text.indexOf(relative.startsWith('build') ? 'const tasks =' : '// @needsAudit', start);
        assert.ok(end > start);
        const providers = new Map();
        const script = new vm.Script(text.slice(start, end));
        const AppRegistry = { registerHeadlessTask: (key, provider) => providers.set(key, provider) };
        script.runInNewContext({ Platform: { OS: 'android' }, AppRegistry, Promise });
        assert.equal(providers.size, 1);
        let settled = false;
        const task = providers.get('expo-task-manager')()({ appScopeKey: 'test' });
        task.then(() => { settled = true; }, () => { settled = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'JS must not finish the keep-alive while Expo work is awaiting auth/timers');
        providers.clear();
        script.runInNewContext({ Platform: { OS: 'ios' }, AppRegistry, Promise });
        assert.equal(providers.size, 0, 'Android keep-alive must not register on iOS');
    });
}
