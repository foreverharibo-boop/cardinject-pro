import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

test('구버전 재배치 설정을 무시하고 모든 기존 depth·최하단 system·채팅·작가노트를 보존한다', async () => {
    const keys = ['window', 'jQuery', 'SillyTavern', 'fetch', 'csiInterceptor', 'CharSheetInjectorBridge', '_csiHooked', '_csiNoteContent', '_csiAnalyzing'];
    const saved = new Map(keys.map(k => [k, { exists: Object.hasOwn(globalThis, k), value: globalThis[k] }]));
    const logs = { info: console.info, debug: console.debug, warn: console.warn };
    console.info = console.debug = console.warn = () => {};
    const listeners = new Map(), sent = [], calls = [];
    const cats = ['chat_top', 'chat_deep', 'chat_mid', 'chat_recent', 'chat_bottom', 'pre_assist', 'sys_bottom', 'after_char']
        .map(position => ({ key: position, name: position, position, content: 'CSI_' + position, enabled: true }));
    const oai = freeze({ prompts: [{ identifier: 'main', content: 'BASE' }, { identifier: 'history', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'history', enabled: true }] }] });
    const legacyPositions = freeze({ history: 'sys_top', main: 'chat_bottom' });
    const legacyOrder = freeze({ '100001': ['history', 'main'] });
    const foreign = freeze({ value: 'FOREIGN', role: 0, depth: 3, position: 1 });
    const context = {
        characterId: 0, characters: [{ name: 'Emris', avatar: 'E.png' }, { name: 'Other', avatar: 'O.png' }],
        name1: 'Dana', name2: 'Emris', chat: freeze([{ is_user: true, mes: 'Latest turn' }]),
        chatMetadata: freeze({ note_prompt: 'NOTE', note_depth: 0, foreign: { keep: true } }), oaiSettings: oai,
        extensionSettings: { charsheet_injector: { perChar: { 'E.png': { categories: cats } }, selectedCharIdx: 0,
            activeKeys: ['foreign'], presetPositions: legacyPositions, markerOriginalOrders: legacyOrder } },
        extensionPrompts: { foreign },
        eventTypes: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat', CHARACTER_SELECTED: 'character', CHAT_COMPLETION_SETTINGS_READY: 'settings', GENERATE_BEFORE_COMBINE_PROMPTS: 'combine' },
        eventSource: {
            on(e, h) { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e).add(h); },
            removeListener(e, h) { listeners.get(e)?.delete(h); },
        },
        setExtensionPrompt(...args) { assert.notEqual(args[0], 'foreign'); calls.push(args); },
    };
    const snapshot = JSON.stringify({ oai, cats, note: context.chatMetadata, positions: legacyPositions, order: legacyOrder });
    const emit = (event, ...args) => { for (const handler of listeners.get(event) ?? []) handler(...args); };
    globalThis.window = globalThis;
    globalThis.jQuery = () => {};
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; };
    async function sendOpenAIRequest(body) {
        emit('settings', body);
        return globalThis.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body) });
    }
    async function sendGenerationRequest(body) { return await sendOpenAIRequest(body); }
    const fixture = () => ({ type: 'quiet', model: 'main', messages: [
        { role: 'system', content: 'BASE' }, ...Array.from({ length: 18 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'TURN_' + i })),
        { role: 'user', content: 'Latest turn' },
    ] });
    let mod;
    try {
        mod = await import('../index.js?legacy-safety'); mod.onEnable();
        emit('start', 'quiet'); emit('combine');
        await globalThis.csiInterceptor(context.chat, 0, () => {}, 'normal');
        await globalThis.csiInterceptor(context.chat, 0, () => {}, 'quiet');
        const body = fixture(), originalMessages = freeze(body.messages);
        await sendGenerationRequest(body);
        const output = sent.at(-1).messages;
        for (const [position, depth] of Object.entries({ chat_top: 100000, chat_deep: 15, chat_mid: 5, chat_recent: 2, chat_bottom: 0, pre_assist: 0, sys_bottom: 100000, after_char: 100000 })) {
            const found = output.findIndex(m => String(m.content).includes('CSI_' + position));
            assert.ok(found >= 0, position);
            assert.equal(output[found].role, 'system', position);
            const following = output.slice(found + 1).filter(m => ['user', 'assistant'].includes(m.role)).length;
            assert.equal(following, Math.min(depth, 19), position + ' depth');
            assert.ok(calls.some(args => args[0] === 'charsheet_injector_' + position && args[2] === 1 && args[3] === depth && args[5] === 0));
        }
        assert.equal(originalMessages.length, 20);
        assert.deepEqual(output.filter(m => ['user', 'assistant'].includes(m.role)), originalMessages.slice(1));
        cats.find(c => c.position === 'chat_mid').customDepth = 0;
        await sendGenerationRequest(fixture());
        const custom = sent.at(-1).messages;
        const customIndex = custom.findIndex(m => String(m.content).includes('CSI_chat_mid'));
        assert.equal(custom.slice(customIndex + 1).filter(m => ['user', 'assistant'].includes(m.role)).length, 0);
        delete cats.find(c => c.position === 'chat_mid').customDepth;
        assert.equal(JSON.stringify({ oai, cats, note: context.chatMetadata, positions: legacyPositions, order: legacyOrder }), snapshot);
        assert.strictEqual(context.extensionPrompts.foreign, foreign);
        context.characterId = 1; emit('character');
        await sendGenerationRequest(fixture());
        assert.doesNotMatch(JSON.stringify(sent.at(-1)), /CSI_chat|CSI_pre_assist/);
        mod.onDisable(); mod.onEnable();
        context.characterId = 0; emit('chat');
        await sendGenerationRequest(fixture());
        assert.match(JSON.stringify(sent.at(-1)), /CSI_chat_bottom/);
        // The bridge adds only to the addressed character's own category store.
        assert.equal(globalThis.CharSheetInjectorBridge.addKink(1, 'Bridge line'), 'added');
        assert.equal(globalThis.CharSheetInjectorBridge.addKink(1, 'Bridge line'), 'duplicate');
        assert.equal(globalThis.CharSheetInjectorBridge.addKink(999, 'Bad'), 'no-character');
        assert.deepEqual(context.extensionSettings.charsheet_injector.perChar['E.png'].categories, cats);
        assert.equal(context.extensionSettings.charsheet_injector.perChar['O.png'].categories[0].content, 'Bridge line');
        assert.equal(JSON.stringify({ oai, cats, note: context.chatMetadata, positions: legacyPositions, order: legacyOrder }), snapshot);
        mod.onDisable();
        assert.ok([...listeners.values()].every(handlers => handlers.size === 0));
        assert.deepEqual(Object.keys(context.extensionPrompts), ['foreign']);
    } finally {
        mod?.onDisable(); Object.assign(console, logs);
        for (const [key, item] of saved) { if (item.exists) globalThis[key] = item.value; else delete globalThis[key]; }
    }
});

test('백그라운드 분석은 별도 프로필로 요청하고 진행 중 추가된 채팅도 삭제하지 않는다', async () => {
    const keys = ['window', 'jQuery', '$', 'SillyTavern', 'fetch', 'csiInterceptor', 'CharSheetInjectorBridge', '_csiAnalyzing', '_csiHooked'];
    const saved = new Map(keys.map(k => [k, { exists: Object.hasOwn(globalThis, k), value: globalThis[k] }]));
    const warn = console.warn; console.warn = () => {};
    let release, called;
    const chat = [{ is_user: true, mes: 'Existing chat' }];
    const ctx = {
        characterId: 0, characters: [{ name: 'Emris', avatar: 'E.png' }], chat,
        extensionSettings: { charsheet_injector: { perChar: {}, selectedCharIdx: 0, activeKeys: [], connectionProfileId: 'analysis-only' }, connectionManager: freeze({ selectedProfile: 'main-profile' }) },
        chatMetadata: freeze({ note_prompt: 'Original note' }),
        ConnectionManagerRequestService: {
            getProfile(id) { assert.equal(id, 'analysis-only'); return { id }; },
            isProfileSupported() { return true; },
            async sendRequest(...args) { called = args; return await new Promise(resolve => { release = resolve; }); },
        },
        generateQuietPrompt() { throw new Error('본채팅 생성 사용 금지'); },
        loadConnectionProfile() { throw new Error('본채팅 연결 변경 금지'); },
    };
    globalThis.window = globalThis; globalThis.jQuery = () => {};
    globalThis.$ = () => { throw new Error('채팅 DOM 접근 금지'); };
    globalThis.SillyTavern = { getContext: () => ctx }; globalThis.fetch = async () => ({ ok: true });
    let mod;
    try {
        mod = await import('../index.js?analysis-safety');
        const pending = mod.callGenerate('Analyze only this sheet');
        while (!release) await new Promise(resolve => setImmediate(resolve));
        chat.push({ is_user: true, mes: 'New real message during analysis' });
        release({ content: '{"categories":[]}' });
        assert.equal(await pending, '{"categories":[]}');
        assert.deepEqual(called, ['analysis-only', 'Analyze only this sheet', 4096, { stream: false, extractData: true, includePreset: false, includeInstruct: false }]);
        assert.equal(chat.length, 2);
        assert.equal(chat[1].mes, 'New real message during analysis');
        assert.equal(ctx.extensionSettings.connectionManager.selectedProfile, 'main-profile');
        assert.equal(ctx.chatMetadata.note_prompt, 'Original note');
        assert.equal(globalThis._csiAnalyzing, false);
        ctx.ConnectionManagerRequestService.sendRequest = async () => { throw new Error('request failed'); };
        await assert.rejects(mod.callGenerate('x'), /request failed/);
        assert.equal(globalThis._csiAnalyzing, false); assert.equal(chat.length, 2);
        delete ctx.extensionSettings.charsheet_injector.connectionProfileId;
        await assert.rejects(mod.callGenerate('x'), /연결 프로필/);
        delete ctx.ConnectionManagerRequestService;
        await assert.rejects(mod.callGenerate('x'), /백그라운드 요청 서비스/);
    } finally {
        mod?.onDisable(); console.warn = warn;
        for (const [key, item] of saved) { if (item.exists) globalThis[key] = item.value; else delete globalThis[key]; }
    }
});

test('배포 코드에 프리셋 재배치·채팅 삭제·전역 프로필 변경 경로가 없고 UI 제목에 버전이 없다', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /_applyMarkerPresetPositions|renderPresetPrompts|record\.order\.splice|oai\.prompt_order\s*=|saveOpenAIPreset|savePreset|chat\.(?:splice|push)|arr\.splice|beforeLen|doCleanup|generateQuietPrompt|loadConnectionProfile|connection_profile_select[^\n]*trigger|setInterval\(/);
    assert.doesNotMatch(source, /id="csi-preset-header"|id="csi-preset-list"/);
    assert.match(source, /AI 응답 바로 직전 \(system, depth 0\)/);
    assert.doesNotMatch(source, /CardInject Pro\s+v\d/);
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.display_name, 'CardInject Pro');
    assert.deepEqual(manifest.hooks, { enable: 'onEnable', disable: 'onDisable' });
});
