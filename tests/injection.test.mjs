import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCategoryInjections, callerKind, mainRequestDecision, requestFingerprint, resolveContent } from '../injection-runtime.js';

const mainStack = 'Error\n at window.fetch (translator.js:100)\n at sendOpenAIRequest (openai.js:3151)\n at async sendGenerationRequest (script.js:6118)\n at async finishGenerating (script.js:5449)';
const rawStack = 'Error\n at sendOpenAIRequest (openai.js:3151)\n at generateRawData (script.js:4000)\n at async sendGenerationRequest (script.js:6118)';
const chat = [{ is_user: true, mes: 'Main scene turn.' }];
const category = (key, position, content = 'CI_' + key, extra = {}) => ({ key, name: key, enabled: true, position, content, ...extra });

test('본답변 quiet를 허용하고 바깥 번역기 이름으로 제외하지 않는다', () => {
    const body = { type: 'quiet', model: 'main', messages: [{ role: 'user', content: 'Main scene turn.' }] };
    assert.equal(callerKind(mainStack), 'main');
    assert.equal(mainRequestDecision(body, mainStack, { chat }).eligible, true);
    assert.equal(body.type, 'quiet');
    assert.equal(mainRequestDecision(body, rawStack, { chat }).eligible, false);
    assert.equal(mainRequestDecision(body, 'at sendRequest (custom-request.js:463)', { chat }).eligible, false);
});

test('확인한 전송 본문만 비동기 재전송을 허용하며 알려진 보조 경로가 우선한다', () => {
    const body = { type: 'quiet', model: 'main', messages: [{ role: 'user', content: 'Main scene turn.' }] };
    const confirmed = new Set([requestFingerprint(body)]);
    assert.equal(mainRequestDecision(body, '', { chat, confirmed }).eligible, true);
    assert.equal(mainRequestDecision(body, rawStack, { chat, confirmed }).eligible, false);
    assert.equal(mainRequestDecision({ ...body, model: 'translator' }, '', { chat, confirmed }).eligible, false);
    assert.equal(mainRequestDecision({ ...body, type: 'impersonate' }, mainStack, { chat }).eligible, false);
});

test('인용된 마지막 턴 조각은 본채팅 일치로 오인하지 않고 알려진 번역 원문은 지원한다', () => {
    const body = { type: 'quiet', messages: [{ role: 'user', content: 'Analyze this: Main scene turn.' }] };
    assert.equal(mainRequestDecision(body, mainStack, { chat }).eligible, false);
    const translatedChat = [{ is_user: true, mes: '집에서 쉴래.', extra: { original_text: 'I will rest at home.' } }];
    body.messages[0].content = 'Dana: I will rest at home.';
    assert.equal(mainRequestDecision(body, mainStack, { chat: translatedChat, names: { userName: 'Dana' } }).eligible, true);
});

test('최상단과 최근 메시지 depth를 실제 system 역할로 주입하고 원본 기록은 보존한다', () => {
    const original = [{ role: 'system', content: 'Base rules.' }, { role: 'user', content: 'Old turn.' }, { role: 'assistant', content: 'Old reply.' }, { role: 'user', content: 'Main scene turn.' }];
    const body = { type: 'quiet', messages: original, model: 'main', stream: false, temperature: 0.7 };
    const report = applyCategoryInjections(body, [category('TOP', 'sys_top'), category('RECENT', 'chat_recent', 'CI_RECENT', { customDepth: 2 })]);
    assert.deepEqual(body.messages.map(item => item.content), ['CI_TOP', 'Base rules.', 'Old turn.', 'CI_RECENT', 'Old reply.', 'Main scene turn.']);
    assert.equal(body.messages[3].role, 'system');
    assert.equal(original.length, 4);
    assert.equal(body.type, 'quiet');
    assert.equal(body.model, 'main');
    assert.equal(body.temperature, 0.7);
    assert.equal(report.missing.length, 0);
});

test('프리셋이 합쳐져 있어도 항목 경계에 삽입하고 같은 위치의 카테고리 순서를 유지한다', () => {
    const body = { messages: [{ role: 'developer', content: 'FIRST\nTarget   line.\nLAST' }] };
    const opts = { presets: [{ identifier: 'target', content: 'Target line.' }] };
    const cats = [category('A', 'preset_after_target'), category('B', 'preset_after_target'), category('BEFORE', 'preset_before_target')];
    applyCategoryInjections(body, cats, opts);
    assert.deepEqual(body.messages.map(item => item.content), ['FIRST\n', 'CI_BEFORE', 'Target   line.', 'CI_A\n\nCI_B', '\nLAST']);
    const again = applyCategoryInjections(body, cats, opts);
    assert.equal(again.changed, false);
    assert.equal(body.messages.filter(item => typeof item.content === 'string' && item.content.includes('CI_A')).length, 1);
});

test('매크로 처리 결과를 사용하고 멀티모달 첨부와 다른 확장 규칙을 보존한다', () => {
    const attachment = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
    const body = { messages: [{ role: 'system', content: [{ type: 'text', text: 'FIRST\nExpanded rules.\nLAST' }, attachment] }, { role: 'system', content: '<ANTI_METAGAMING>other extension</ANTI_METAGAMING>' }] };
    applyCategoryInjections(body, [category('M', 'preset_after_target')], {
        presets: [{ identifier: 'target', content: '{{getvar::rules}}' }],
        prepared: new Map([['target', new Set(['Expanded rules.'])]]),
    });
    assert.equal(body.messages[1].content, 'CI_M');
    assert.deepEqual(body.messages[2].content.at(-1), attachment);
    assert.equal(body.messages.at(-1).content, '<ANTI_METAGAMING>other extension</ANTI_METAGAMING>');
    assert.equal(resolveContent('For {{char}} and {{user}}.', { charName: 'Emris', userName: 'Dana' }), 'For Emris and Dana.');
});

test('작가노트가 합쳐진 경우 본문 끝에 붙이고 마지막의 다른 규칙 앞에 둔다', () => {
    const body = { messages: [{ role: 'system', content: 'FIRST\nNotes for Emris.\nOTHER RULES' }] };
    const cats = [category('N1', 'with_note'), category('N2', 'with_note')];
    const options = { noteText: 'Notes for {{char}}.', names: { charName: 'Emris' } };
    applyCategoryInjections(body, cats, options);
    assert.equal(body.messages[0].content, 'FIRST\nNotes for Emris.\n\nCI_N1\n\nCI_N2\nOTHER RULES');
    assert.equal(applyCategoryInjections(body, cats, options).changed, false);
});

test('작가노트가 없으면 설정된 depth 0도 존중하고 프리셋 실패는 누락 대신 명시적으로 대체한다', () => {
    const body = { messages: [{ role: 'system', content: 'Base.' }, { role: 'user', content: 'Main scene turn.' }] };
    const result = applyCategoryInjections(body, [category('NOTE', 'with_note'), category('PRESET', 'preset_after_missing')], { noteDepth: 0 });
    assert.equal(body.messages[2].content, 'CI_NOTE');
    assert.equal(body.messages[3].content, 'CI_PRESET');
    assert.equal(result.missing.length, 2);
    assert.equal(result.missing[0].reason, 'author_note_depth_fallback');
    assert.equal(result.missing[1].reason, 'preset_entry_missing');
    const again = applyCategoryInjections(body, [category('NOTE', 'with_note'), category('PRESET', 'preset_after_missing')], { noteDepth: 0 });
    assert.equal(again.changed, false);
    assert.deepEqual(again.missing.map(item => item.reason), result.missing.map(item => item.reason));
});

test('중복된 프리셋 본문을 편의상 한 대상으로 취급하지 않는다', () => {
    const body = { messages: [{ role: 'system', content: 'Target.\nTarget.' }, { role: 'system', content: 'Target.' }] };
    const result = applyCategoryInjections(body, [category('P', 'preset_after_target')], {
        presets: [{ identifier: 'target', content: 'Target.' }],
    });
    assert.equal(result.missing[0].reason, 'preset_content_missing_or_ambiguous');
    assert.equal(body.messages.at(-1).content, 'CI_P');
});

test('서로 다른 depth와 다른 위치가 섞여도 실제 채팅 턴 기준을 유지한다', () => {
    const body = { messages: [{ role: 'system', content: 'Base.' }, { role: 'user', content: 'Old.' }, { role: 'assistant', content: 'Reply.' }, { role: 'user', content: 'Latest.' }] };
    applyCategoryInjections(body, [category('SHALLOW', 'chat_recent', 'SHALLOW', { customDepth: 1 }),
        category('TOP', 'sys_top'), category('DEEP', 'chat_recent', 'DEEP', { customDepth: 3 })]);
    assert.deepEqual(body.messages.map(message => message.content), ['CI_TOP', 'Base.', 'DEEP', 'Old.', 'Reply.', 'SHALLOW', 'Latest.']);
});

test('비활성 카테고리는 제외하고 동일 본문 두 카테고리는 요청한 수만큼 유지한다', () => {
    const body = { messages: [{ role: 'user', content: 'Main scene turn.' }] };
    const cats = [category('A', 'sys_top', 'SAME'), category('B', 'sys_top', 'SAME'), category('OFF', 'sys_top', 'OFF', { enabled: false })];
    applyCategoryInjections(body, cats);
    assert.equal(body.messages[0].content, 'SAME\n\nSAME');
    assert.equal(applyCategoryInjections(body, cats).changed, false);
    assert.doesNotMatch(JSON.stringify(body), /OFF/);
});

test('실제 fetch와 설정 이벤트에서 quiet 본생성 4위치를 주입하고 raw 보조·Request·후속 래퍼를 처리한다', async () => {
    const globals = ['window', 'jQuery', 'SillyTavern', 'fetch', 'toastr', 'csiInterceptor', '_csiHooked', '_csiAnalyzing'];
    const saved = new Map(globals.map(key => [key, { exists: Object.hasOwn(globalThis, key), value: globalThis[key] }]));
    const listeners = new Map(), requests = [], promptCalls = [];
    const events = { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', CHAT_COMPLETION_SETTINGS_READY: 'settings', CHAT_CHANGED: 'chat' };
    const cats = [category('TOP', 'sys_top'), category('RECENT', 'chat_recent'), category('NOTE', 'with_note'), category('P1', 'preset_after_target'), category('P2', 'preset_after_target')];
    const context = {
        chatId: 'integration', characterId: 0, characters: [{ name: 'Emris', avatar: 'Emris.png' }], chat,
        name1: 'Dana', name2: 'Emris',
        extensionSettings: { charsheet_injector: { perChar: { 'Emris.png': { categories: cats } }, selectedCharIdx: 0, activeKeys: [] } },
        chatMetadata: { note_prompt: 'Note rules.', note_depth: 0 }, extensionPrompts: {},
        oaiSettings: { prompts: [{ identifier: 'target', content: 'Target rules.' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'target', enabled: true }] }] },
        eventTypes: events, eventSource: { on(event, handler) { listeners.set(event, handler); } },
        setExtensionPrompt(...args) { promptCalls.push(args); },
    };
    globalThis.window = globalThis;
    globalThis.jQuery = () => {}; // Skip UI boot; exercise the real request hooks.
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options) => {
        const input = url instanceof Request;
        requests.push({ body: JSON.parse(options?.body ?? await url.clone().text()), headers: options?.headers ?? (input ? url.headers : null) });
        return { ok: true };
    };
    try {
        const module = await import('../index.js?quiet-integration');
        module._installFetchHook(); module._registerInjectionRequestHooks();
        const makeBody = () => ({ type: 'quiet', model: 'main', stream: false, messages: [
            { role: 'system', content: 'FIRST\nTarget rules.\nLAST' }, { role: 'system', content: 'Note rules.' },
            { role: 'user', content: 'Old user.' }, { role: 'assistant', content: 'Old reply.' }, { role: 'user', content: 'Main scene turn.' },
        ] });
        async function sendOpenAIRequest(body) {
            listeners.get('settings')(body);
            return globalThis.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body) });
        }
        async function sendGenerationRequest(body) { return await sendOpenAIRequest(body); }
        async function generateRawData(body) { return await sendOpenAIRequest(body); }
        listeners.get('start')('quiet');
        const originalChat = structuredClone(context.chat);
        await globalThis.csiInterceptor(context.chat, 0, () => {}, 'quiet');
        assert.deepEqual(context.chat, originalChat);
        globalThis._csiAnalyzing = true; // Concurrent analysis must not block a proved main sender.
        await generateRawData(makeBody());
        assert.doesNotMatch(JSON.stringify(requests.at(-1).body), /CI_TOP|CI_RECENT|CI_NOTE|CI_P1/);
        const body = makeBody(), originalMessages = structuredClone(body.messages);
        await sendGenerationRequest(body);
        const actual = requests.at(-1).body;
        assert.equal(actual.type, 'quiet');
        assert.equal(actual.model, 'main');
        assert.equal(actual.messages[0].content, 'CI_TOP');
        assert.deepEqual(originalMessages, makeBody().messages);
        assert.deepEqual(cats, context.extensionSettings.charsheet_injector.perChar['Emris.png'].categories);
        for (const marker of ['CI_TOP', 'CI_RECENT', 'CI_NOTE', 'CI_P1', 'CI_P2']) assert.equal(JSON.stringify(actual).split(marker).length - 1, 1);
        assert.equal(actual.messages.find(item => item.content === 'CI_RECENT').role, 'system');
        const targetIndex = actual.messages.findIndex(item => item.content === 'FIRST\nTarget rules.');
        assert.equal(actual.messages[targetIndex + 1].content, 'CI_P1\n\nCI_P2');
        assert.ok(actual.messages.some(item => item.content === 'Note rules.\n\nCI_NOTE'));
        // A certified Request keeps headers and its original body stream.
        const serialized = JSON.stringify(actual);
        const request = new Request('https://st.example/api/backends/chat-completions/generate', { method: 'POST', body: serialized, headers: { 'X-Fixture': 'kept' } });
        await globalThis.fetch(request);
        assert.equal(requests.at(-1).headers.get('X-Fixture'), 'kept');
        assert.equal(await request.text(), serialized);
        // Reattach after another extension replaces fetch and erases one block.
        const oldHook = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            const parsed = JSON.parse(options.body);
            parsed.messages = parsed.messages.filter(message => message.content !== 'CI_RECENT');
            parsed.messages.push({ role: 'system', content: '<OTHER_EXTENSION />' });
            return oldHook(url, { ...options, body: JSON.stringify(parsed) });
        };
        await sendGenerationRequest(makeBody());
        assert.equal(JSON.stringify(requests.at(-1).body).split('CI_RECENT').length - 1, 1);
        assert.match(JSON.stringify(requests.at(-1).body), /OTHER_EXTENSION/);
        await generateRawData(makeBody());
        assert.doesNotMatch(JSON.stringify(requests.at(-1).body), /CI_TOP|CI_RECENT|CI_NOTE|CI_P1/);
        // Normal interceptor now uses standard system prompts, not fake assistant chat records.
        globalThis._csiAnalyzing = false;
        const foreign = Object.freeze({ value: 'FOREIGN_PROMPT', position: 1, depth: 5, role: 0 });
        context.extensionPrompts.foreign = foreign;
        context.extensionSettings.charsheet_injector.activeKeys.push('foreign');
        await globalThis.csiInterceptor(context.chat, 0, () => {}, 'normal');
        assert.deepEqual(context.chat, originalChat);
        assert.ok(promptCalls.some(args => args[0] === 'charsheet_injector_RECENT' && args[1] === 'CI_RECENT' && args[2] === 1 && args[3] === 2 && args[5] === 0));
        assert.ok(!promptCalls.some(args => args[1] && args[2] === 13), '프리셋 전용 가상 타입을 ST에 등록하면 안 됨');
        assert.strictEqual(context.extensionPrompts.foreign, foreign);
        assert.ok(!promptCalls.some(args => args[0] === 'foreign'));
        context.extensionSettings.charsheet_injector.activeKeys.push('foreign');
        module.onDisable();
        assert.strictEqual(context.extensionPrompts.foreign, foreign);
        assert.ok(!promptCalls.some(args => args[0] === 'foreign'));
        await sendGenerationRequest(makeBody());
        assert.doesNotMatch(JSON.stringify(requests.at(-1).body), /CI_TOP|CI_RECENT|CI_NOTE|CI_P1/);
        assert.match(JSON.stringify(requests.at(-1).body), /OTHER_EXTENSION/);
    } finally {
        for (const [key, item] of saved) { if (item.exists) globalThis[key] = item.value; else delete globalThis[key]; }
    }
});
