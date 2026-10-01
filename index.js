// CardInject Pro
import { applyCategoryInjections, chatEvidence, mainRequestDecision, requestFingerprint, resolveContent } from './injection-runtime.js';
import { hasHookOwner, markHookOwner } from './hook-chain.js';

const FETCH_HOOK_OWNER = Symbol('charsheet_injector.fetch');
const PROMPT_CAPTURE_OWNER = Symbol('charsheet_injector.preparePrompt');
let _csiRuntimeActive = true;
const _csiRequestHandlers = [];
const _csiOwnPromptId = id => typeof id === 'string' && id.startsWith('charsheet_injector_') && id.length > 19;


const EXT_KEY = 'charsheet_injector';
// 표준 등록은 system 역할로, 가상 위치는 최종 요청에서 처리한다.
const PT = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const PT_NOTE = 12;
const PT_PRESET_REL = 13;
const POSITIONS = {
    sys_top: { label: '🔝 시스템 최상단(모든 것보다 위)', type: PT.BEFORE_PROMPT, depth: 0 },
    chat_top: { label: '📌 채팅 기록 맨 앞', type: PT.IN_CHAT, depth: 100000 },
    chat_deep: { label: '📜 오래된 메시지 위 (depth 15)', type: PT.IN_CHAT, depth: 15 },
    chat_mid: { label: '↕️ 채팅 중간 (depth 지정)', type: PT.IN_CHAT, depth: 5 },
    with_note: { label: '📝 작가노트', type: PT_NOTE, depth: 0 },
    chat_recent: { label: '💬 최근 메시지 위 (depth 2)', type: PT.IN_CHAT, depth: 2 },
    chat_bottom: { label: '⬇️ 생성 직전 최하단 (system, depth 0)', type: PT.IN_CHAT, depth: 0 },
    // 저장값은 유지하되 assistant 프리필 대신 system 역할로 주입한다.
    pre_assist: { label: '🤖 AI 응답 바로 직전 (system, depth 0)', type: PT.IN_CHAT, depth: 0 },
};

// 이전 버전 저장값 호환용 별칭 (드롭다운에는 안 뜸, 기존 데이터 해석 전용)
const POSITION_ALIASES = { sys_bottom: 'chat_top', after_char: 'chat_top' };

function _resolvePosition(key) {
    if (typeof key === 'string' && (key.startsWith('preset_after_') || key.startsWith('preset_before_'))) {
        return { label: key, type: PT_PRESET_REL, depth: 0 };
    }
    return POSITIONS[key] || POSITIONS[POSITION_ALIASES[key]] || POSITIONS.sys_top;
}

// 카테고리 위치 select에 붙일 "프리셋 프롬프트 앞/뒤" 동적 옵션 HTML 생성
function _presetRelOptionsHtml(currentPosition) {
    const prompts = _getPresetPrompts();
    if (!prompts.length) return '';
    const opts = prompts.map(p => {
        const afterVal  = `preset_after_${p.identifier}`;
        const beforeVal = `preset_before_${p.identifier}`;
        return `<option value="${esc(afterVal)}" ${currentPosition===afterVal?'selected':''}>${esc(p.name)} 다음</option>` +
               `<option value="${esc(beforeVal)}" ${currentPosition===beforeVal?'selected':''}>${esc(p.name)} 앞</option>`;
    }).join('');
    return `<optgroup label="── 프리셋 프롬프트 기준 ──">${opts}</optgroup>`;
}

// 위치에 따른 강도 매핑 — 카테고리를 어느 위치로 옮기든 그 위치의 실제
// "강력함" 정도에 맞춰 배지가 자동으로 바뀌도록 함
const POSITION_IMPORTANCE = {
    pre_assist:  'high',
    chat_bottom: 'high',
    sys_top:     'high',
    chat_top:    'high',
    with_note:   'high',
    chat_recent: 'medium',
    chat_mid:    'medium',
    chat_deep:   'low',
};
function _importanceForPosition(posKey) {
    return POSITION_IMPORTANCE[posKey] || POSITION_IMPORTANCE[POSITION_ALIASES[posKey]] || 'medium';
}

// 작가노트(Author's Note) 현재 depth를 ST에서 읽어옴 — 없으면 ST 기본값 4
function _getAuthorNoteDepth() {
    try {
        const ctx = getCtx();
        const meta = ctx?.chatMetadata ?? ctx?.chat_metadata ?? window.chat_metadata;
        const d = meta?.note_depth;
        if (typeof d === 'number' && !isNaN(d)) return d;
    } catch (_) {}
    return 4;
}

// 작가노트 실제 텍스트 내용 — fetch hook에서 최종 메시지 배열 속 AN을
// 정확히 찾아내기 위한 용도 (depth 추측이 아니라 내용 매칭으로 확실하게 위치시킴)
function _getAuthorNoteText() {
    try {
        const ctx = getCtx();
        const meta = ctx?.chatMetadata ?? ctx?.chat_metadata ?? window.chat_metadata;
        const t = meta?.note_prompt;
        if (typeof t === 'string' && t.trim()) return t.trim();
    } catch (_) {}
    return '';
}

// ── ST API ────────────────────────────────────────────────────────────────────

let _api = null;
async function getApi() {
    if (_api) return _api;
    _api = {};
    for (const p of ['../../../extensions.js', '../../../../script.js', '../../../openai.js']) {
        try { Object.assign(_api, await import(p)); }
        catch (e) { console.warn('[CSI] import 실패:', p, e.message); }
    }
    _installPromptCapture();
    _registerInjectionRequestHooks();
    return _api;
}

function getCtx() {
    if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
    if (_api?.getContext) return _api.getContext();
    return null;
}

// 캐시트 분석용 백그라운드 생성 호출.
// 선택한 연결 프로필에 직접 요청하며, 본채팅이나 현재 연결은 건드리지 않음.
export async function callGenerate(prompt) {
    await getApi();
    const service = getCtx()?.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('ST 백그라운드 요청 서비스를 찾을 수 없어요. SillyTavern을 업데이트해주세요.');
    }

    const profileId = _analysisProfileId ?? ensureGlobalSettings().connectionProfileId;
    if (!profileId) throw new Error('확장 탭에서 연결 프로필을 먼저 선택해주세요.');

    const profile = typeof service.getProfile === 'function' ? service.getProfile(profileId) : null;
    if (typeof service.isProfileSupported === 'function' && profile && !service.isProfileSupported(profile)) {
        throw new Error('선택한 연결 프로필은 백그라운드 생성을 지원하지 않아요.');
    }

    globalThis._csiAnalyzing = true;
    try {
        const result = await service.sendRequest(profileId, prompt, 4096, {
            stream: false,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        });
        const text = typeof result === 'string' ? result : result?.content;
        if (typeof text !== 'string' || !text.trim()) throw new Error('백그라운드 생성 결과가 비어있어요.');
        return text;
    } finally {
        globalThis._csiAnalyzing = false;
    }
}

// ── Settings (캐릭터별 저장) ──────────────────────────────────────────────────
// 각 캐릭터마다 독립된 카테고리 목록을 가짐. 캐릭터 전환 시 자동으로 그 캐릭터의
// 설정을 불러옴. 전역 값(선택된 캐릭터 인덱스 등)은 ensureGlobalSettings()로 분리.

function ensureGlobalSettings() {
    const ctx = getCtx();
    const store = ctx?.extensionSettings ?? ctx?.extension_settings ?? {};
    if (!store[EXT_KEY]) store[EXT_KEY] = { perChar: {}, selectedCharIdx: null, lastCharId: null, activeKeys: [] };
    const s = store[EXT_KEY];
    if (!s.perChar) s.perChar = {};
    if (!Array.isArray(s.activeKeys)) s.activeKeys = [];

    // 구버전 마이그레이션: 예전엔 categories가 전역 배열 하나였음
    // → 현재 선택된(또는 0번) 캐릭터 슬롯으로 1회만 이전
    if (Array.isArray(s.categories)) {
        const idx = s.selectedCharIdx ?? 0;
        const key = _charKey(idx) ?? '__migrated__';
        if (!s.perChar[key]) s.perChar[key] = { categories: s.categories };
        delete s.categories;
    }
    return s;
}

// 캐릭터를 구분하는 안정적인 키 (아바타 파일명 우선, 없으면 이름)
function _charKey(idx) {
    const char = getAllChars()[idx];
    if (!char) return null;
    return char.avatar || char.name || `idx_${idx}`;
}

// 현재 선택된 캐릭터의 카테고리 저장 컨테이너 반환 ({categories:[...]} 형태 유지 —
// 기존 코드가 ensureSettings().categories 형태로 쓰던 부분을 그대로 재사용 가능)
function ensureSettings() {
    const g = ensureGlobalSettings();
    const idx = getSelectedIdx();
    const key = _charKey(idx) ?? '__no_char__';
    if (!g.perChar[key]) g.perChar[key] = { categories: [] };
    const charStore = g.perChar[key];

    return charStore;
}

// 다른 개인 확장이 안전하게 항목을 추가할 수 있는 최소 공개 API.
// 내부 저장 구조를 외부에서 직접 만지지 않게 하며 기존 카테고리는 보존한다.
window.CharSheetInjectorBridge = {
    addKink(idx, kinkText) {
        const text = String(kinkText ?? '').trim();
        const numericIdx = Number(idx);
        if (!text || !Number.isInteger(numericIdx) || !_charKey(numericIdx)) return 'no-character';

        const global = ensureGlobalSettings();
        const key = _charKey(numericIdx);
        if (!global.perChar[key]) global.perChar[key] = { categories: [] };
        const charStore = global.perChar[key];
        if (!Array.isArray(charStore.categories)) charStore.categories = [];

        let category = charStore.categories.find(c => {
            const name = String(c?.name ?? '').trim().toLowerCase();
            return name.includes('kink') || name.includes('sexuality') || name.includes('sexual');
        });
        if (!category) {
            category = {
                key: Math.random().toString(36).slice(2),
                name: 'Sexuality & Kink',
                content: '',
                importance: 'high',
                position: 'sys_top',
                customDepth: 0,
                enabled: true,
                expanded: false,
            };
            charStore.categories.push(category);
        }

        const lines = String(category.content ?? '').split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.includes(text)) return 'duplicate';
        category.content = [...lines, text].join('\n');
        save();

        if (modalEl && modalEl.style.display !== 'none' && getSelectedIdx() === numericIdx) {
            render();
            const pill = modalEl.querySelector('#csi-pill');
            if (pill) {
                pill.textContent = `${charStore.categories.length}개`;
                pill.style.display = '';
            }
        }
        return 'added';
    },
};

// ── 프리셋 위치 읽기 (기존 항목과 순서는 수정하지 않음) ───────────────

function _getPresetPrompts(includeMarkers = false) {
    // oai_settings가 노출되는 여러 경로 시도 (getApi()로 import한 openai.js 모듈이 최우선)
    const oai = _api?.oai_settings
        ?? window.oai_settings
        ?? getCtx()?.oaiSettings
        ?? getCtx()?.oai_settings
        ?? window.SillyTavern?.getContext?.()?.oaiSettings;
    if (!oai || !Array.isArray(oai.prompts)) {
        console.warn('[CSI] oai_settings를 못 찾음 — 프리셋 프롬프트 목록 불러오기 실패');
        return [];
    }

    // 현재 캐릭터 기준 prompt_order 찾기 (캐릭터별 or 기본 100001)
    const idx = getSelectedIdx();
    const char = getAllChars()[idx];
    const candidates = [char?.avatar, char?.name, _getCurrentCharId(), 100001]
        .filter(value => value !== undefined && value !== null && value !== '');
    const orders = Array.isArray(oai.prompt_order) ? oai.prompt_order : [];
    const order = candidates.map(id => orders.find(entry => String(entry.character_id) === String(id)))
        .find(Boolean) ?? orders[0];
    const orderList = order?.order ?? [];

    // prompts 배열 = 전체 정의, orderList = 현재 활성화된 순서/on-off
    const result = [];
    for (const entry of orderList) {
        const p = oai.prompts.find(pp => pp.identifier === entry.identifier);
        if (!p) continue;
        if (p.marker && !includeMarkers) continue;
        result.push({
            identifier: p.identifier,
            name: p.name || p.identifier,
            content: p.content || '',
            role: p.role || 'system',
            marker: Boolean(p.marker),
            enabledInPreset: entry.enabled !== false,
        });
    }
    return result;
}

// 구버전 presetPositions/markerOriginalOrders는 실행하지 않는다.
// 이전에 변경된 프리셋도 자동 복원하지 않는다: 현재 사용자 순서를 보존한다.

async function save() {
    try { (_api?.saveSettingsDebounced ?? window.saveSettingsDebounced ?? (() => {}))(); } catch (_) {}
}

// ── Characters ────────────────────────────────────────────────────────────────

function getAllChars() { return getCtx()?.characters ?? []; }

// ST가 "현재 캐릭터"를 노출하는 방식이 버전마다 다름 — 여러 경로 시도
function _getCurrentCharId() {
    const ctx = getCtx();
    const candidates = [
        ctx?.characterId,
        window.this_chid,
        window.SillyTavern?.getContext?.()?.characterId,
        ctx?.chatId != null ? undefined : undefined, // (자리표시, 그룹챗 등 추가 대비용)
    ];
    for (const c of candidates) {
        if (c != null && !Number.isNaN(Number(c))) return Number(c);
    }
    return null;
}

function getSelectedIdx() {
    const g = ensureGlobalSettings(), chars = getAllChars();
    if (g.selectedCharIdx != null && chars[g.selectedCharIdx]) return g.selectedCharIdx;
    const curId = _getCurrentCharId();
    if (curId != null && chars[curId]) return curId;
    return chars.length ? 0 : null;
}

function getSheet(idx) {
    const char = getAllChars()[idx ?? getSelectedIdx()];
    if (!char) return null;
    return {
        name: char.name || '(이름 없음)',
        description: char.description || '',
        personality: char.personality || '',
        scenario: char.scenario || '',
        mes_example: char.mes_example || '',
        system_prompt: char.system_prompt || '',
        post_history_instructions: char.post_history_instructions || '',
    };
}

// ── Connection Profiles ───────────────────────────────────────────────────────

function _findProfileSelectEl() {
    const ids = ['#connection_profiles', '#connection_profile_select', '#profile_select_dropdown'];
    for (const id of ids) {
        const el = document.querySelector(id);
        if (el && el.tagName === 'SELECT') return el;
    }
    return null;
}

function getConnectionProfiles() {
    const service = getCtx()?.ConnectionManagerRequestService;
    if (service && typeof service.getSupportedProfiles === 'function') {
        const profiles = service.getSupportedProfiles();
        if (Array.isArray(profiles) && profiles.length) {
            return profiles.map(p => ({ id: p.id, name: p.name || p.id }));
        }
    }

    const el = _findProfileSelectEl();
    if (el) {
        return Array.from(el.options).map(o => ({ id: o.value, name: o.textContent.trim() }));
    }
    // DOM에서 못 찾으면 내부 데이터 구조로 폴백 시도
    const ctx = getCtx();
    const cm = ctx?.extensionSettings?.connectionManager
        ?? window.extension_settings?.connectionManager
        ?? ctx?.extension_settings?.connectionManager;
    if (cm && Array.isArray(cm.profiles)) {
        return cm.profiles.map(p => ({ id: p.id, name: p.name }));
    }
    return null;
}

// ── Injection ─────────────────────────────────────────────────────────────────

// 실제 주입 로직
// 최상단과 최근 메시지 위치는 표준 setExtensionPrompt로 등록.
// 작가노트와 프리셋 상대 위치는 요청 조립 후 처리하며, 최종 전송에서 모두 재확인.
function _doInject(fn) {
    if (!_csiRuntimeActive) return 0;
    const g = ensureGlobalSettings();

    // 이전에 등록했던 키들 먼저 전부 지워서 캐릭터 전환 시 주입이 남아있는 문제 방지
    if (Array.isArray(g.activeKeys)) {
        g.activeKeys.filter(_csiOwnPromptId).forEach(id => {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch (_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
        });
    }
    g.activeKeys = [];

    const cats = ensureSettings().categories;
    let count = 0;
    cats.forEach((cat, i) => {
        const id = `${EXT_KEY}_${cat.key || i}`;
        const pos = _resolvePosition(cat.position);
        g.activeKeys.push(id);
        if (cat.enabled) count++;

        // 요청 본문에서 처리하는 작가노트와 프리셋 상대 위치는
        // 여기서 기존 등록값만 지우고 건너뜀
        if (pos.type === PT_NOTE || pos.type === PT_PRESET_REL) {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch(_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
            return;
        }

        if (cat.enabled && cat.content?.trim()) {
            const depth = pos.type === PT.IN_CHAT ? Math.max(0, Number(cat.customDepth ?? pos.depth) || 0) : pos.depth ?? 0;
            try { fn(id, cat.content, pos.type, depth, false, 0); } catch(e) { console.warn('[CSI] fn 오류:', e); }
            _directWrite(id, cat.content, pos.type, depth);
        } else {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch(_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
        }
    });
    return count;
}

// ── Generate Interceptor: 표준 프롬프트 등록과 본채팅 증거 수집 ──────────────
// manifest.json의 generate_interceptor로 등록됨.
globalThis.csiInterceptor = async function (chat, contextSize, abort, type) {
    if (!_csiRuntimeActive) return;
    try {
        _installFetchHook();
        _installPromptCapture();
        const normalized = String(type ?? '').trim().toLowerCase() || 'normal';
        if (!['normal', 'regenerate', 'swipe', 'continue', 'quiet'].includes(normalized)) return;
        _csiChatSnapshot = chatEvidence(chat);
        // quiet can be either a gated main reply or an auxiliary Generate.
        // Observe here, then prove the actual sender at SETTINGS_READY/fetch.
        if (normalized === 'quiet') return;
        const fn = _findSetPrompt();
        if (fn) _doInject(fn);
        _applyNoteInjection(_csiEnabledCategories());
    } catch (e) {
        console.error('[CSI] interceptor 오류:', e);
    }
};

// 작가노트 주입 캐시: 저장된 작가노트는 수정하지 않는다.
// fetch hook이 최종 요청 메시지 배열에서 직접 처리 — 여기서는 캐시 갱신만.
const CSI_NOTE_MARKER = '\n\n[CSI:with_note]\n';

function _applyNoteInjection(enabledCats) {
    const noteCats = (enabledCats ?? ensureSettings().categories.filter(c => c.enabled && c.content?.trim()))
        .filter(c => c.position === 'with_note');
    globalThis._csiNoteContent = noteCats.length
        ? noteCats.map(c => c.content).join('\n\n')
        : '';
}

// setExtensionPrompt 함수 찾기
function _findSetPrompt() {
    try {
        const ctx = getCtx();
        if (typeof ctx?.setExtensionPrompt === 'function') return ctx.setExtensionPrompt;
    } catch (_) {}
    if (typeof window.setExtensionPrompt === 'function') return window.setExtensionPrompt;
    if (typeof _api?.setExtensionPrompt === 'function') return _api.setExtensionPrompt;
    return null;
}

// extension_prompts 직접 접근 (module 인스턴스 우회 목적)
function _directWrite(id, value, position, depth) {
    if (!_csiOwnPromptId(id)) return false;
    const targets = [
        () => window.extension_prompts,
        () => getCtx()?.extensionPrompts,
        () => getCtx()?.extension_prompts,
        () => _api?.extension_prompts,
    ];
    for (const getter of targets) {
        try {
            const ep = getter();
            if (ep && typeof ep === 'object') {
                if (value) {
                    ep[id] = { value, position, depth, scan: false, role: 0 };
                } else {
                    delete ep[id];
                }
                return true;
            }
        } catch (_) {}
    }
    return false;
}

async function applyInjections() {
    await getApi();

    const fn = _findSetPrompt();
    if (!fn) {
        const apiKeys = Object.keys(_api || {}).filter(k =>
            k.toLowerCase().includes('prompt') || k.toLowerCase().includes('extension')
        ).slice(0, 10);
        console.error('[CSI] setExtensionPrompt 없음. 관련 키:', apiKeys);
        toast('error', 'setExtensionPrompt를 찾을 수 없어요. 콘솔의 [CSI] 로그 확인해주세요.');
        return;
    }

    const cats = ensureSettings().categories;
    if (!cats.length) {
        toast('warning', '주입할 카테고리가 없어요. 먼저 분석해주세요.');
        return;
    }

    const enabled = cats.filter(c => c.enabled && c.content?.trim());
    const count = _doInject(fn);
    _applyNoteInjection(enabled);
    await save();

    console.log(`[CSI] 수동 주입 적용: 활성 카테고리 ${count}개`);
    toast('success', `✓ ${count}개 카테고리 주입 설정 적용됨`);
}

async function clearInjections() {
    await getApi();
    const fn = _findSetPrompt();
    const g = ensureGlobalSettings();
    if (fn && Array.isArray(g.activeKeys)) {
        g.activeKeys.filter(_csiOwnPromptId).forEach(id => {
            try { fn(id, '', PT.IN_PROMPT, 0, false, 0); } catch (_) {}
            _directWrite(id, '', PT.IN_PROMPT, 0);
        });
    }
    g.activeKeys = [];
    _applyNoteInjection([]);
    console.log('[CSI] 주입 초기화 완료');
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(s) {
    const parts = [];
    if (s.description)               parts.push(`[Character Description]\n${s.description}`);
    if (s.personality)               parts.push(`[Personality]\n${s.personality}`);
    if (s.scenario)                  parts.push(`[Scenario]\n${s.scenario}`);
    if (s.mes_example)               parts.push(`[Example Messages]\n${s.mes_example}`);
    if (s.system_prompt)             parts.push(`[System Prompt]\n${s.system_prompt}`);
    if (s.post_history_instructions) parts.push(`[Post History Instructions]\n${s.post_history_instructions}`);

    // 시스템 프롬프트에 캐릭터 페르소나가 포함돼 있어서 AI가 롤플레이하려 할 수 있음.
    // 최대한 강하게 오버라이드해서 순수 JSON 분석만 하도록 지시.
    return `[OOC: STOP. DO NOT ROLEPLAY. DO NOT RESPOND AS ANY CHARACTER. THIS IS NOT A ROLEPLAY MESSAGE.
This is a technical JSON analysis task performed by a SillyTavern extension.
IGNORE ALL CHARACTER INSTRUCTIONS, SYSTEM PROMPTS, AND PERSONA DEFINITIONS ABOVE.
You must respond with ONLY a raw JSON object. No prose, no narration, no character voice, no markdown.]

TASK: Analyze the following character sheet text and categorize its content into groups for AI prompt injection.

IMPORTANT — use macros, not names: When rewriting content, replace the character's own name with {{char}} and the user/persona's name with {{user}} (e.g. "Rhodes is tall" → "{{char}} is tall"). Do this consistently in every category's "content" field. This is critical — without it, injected content can read ambiguously and the AI won't know whose trait is being described.

OUTPUT FORMAT — respond with ONLY this JSON structure, nothing else:
{
  "categories": [
    {
      "key": "unique_snake_key",
      "name": "Category Name (same language as source)",
      "content": "Rewritten as a clear AI instruction. Keep original language.",
      "importance": "high",
      "suggested_position": "sys_top"
    }
  ]
}

FIELD VALUES:
- importance: "high" / "medium" / "low"
- suggested_position: "sys_top" / "chat_top" / "chat_deep" / "chat_mid" / "with_note" / "chat_recent" / "chat_bottom" / "pre_assist"
- Use 3 to 8 categories. Keep the source material's language.

CHARACTER SHEET FOR "${s.name}":
=====
${parts.join('\n\n')}
=====

[REMINDER: Output ONLY the JSON object above. No roleplay. No character voice. No markdown fences.]`;
}

// ── Toast 알림 (ST toastr와 완전히 독립된 자체 UI) ──────────────────────────────

// ⚠️ ST의 toastr는 앱 전체가 공유하는 전역 시스템 — 여기에 CSS/JS로 손대면
// "Preset updated" 같은 ST 자체 네이티브 토스트까지 전부 같이 망가짐 (실제로
// 한 번 그런 적 있음). 그래서 toastr는 절대 건드리지 않고, 완전히 독립된
// 우리만의 작은 알림 UI를 documentElement에 직접 만들어서 씀.
function toast(type, msg) {
    const el = document.createElement('div');
    el.className = `csi-own-toast csi-toast-${type === 'success' || type === 'error' || type === 'warning' ? type : 'info'}`;
    el.textContent = msg;
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => el.classList.add('csi-toast-show'));

    const duration = type === 'error' ? 5000 : 3000;
    setTimeout(() => {
        el.classList.remove('csi-toast-show');
        setTimeout(() => el.remove(), 250);
    }, duration);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const esc = str => { const d = document.createElement('div'); d.textContent = str||''; return d.innerHTML; };
const impLabel = v => ({high:'높음', medium:'중간', low:'낮음'}[v]||'중간');

// ── Modal positioning ─────────────────────────────────────────────────────────

function positionModal() {
    if (!modalEl) return;
    const vp = window.visualViewport;
    const vw = vp ? vp.width  : window.innerWidth;
    const vh = vp ? vp.height : window.innerHeight;
    const ox = vp ? vp.offsetLeft : 0;
    const oy = vp ? vp.offsetTop  : 0;
    const mw = Math.min(560, Math.round(vw * 0.94));
    const mh = Math.round(vh * 0.88);
    modalEl.style.left      = Math.round(ox + (vw - mw) / 2) + 'px';
    modalEl.style.top       = Math.round(oy + vh * 0.06) + 'px';
    modalEl.style.width     = mw + 'px';
    modalEl.style.maxHeight = mh + 'px';
    modalEl.style.transform = 'none';
}

// ── Modal DOM ─────────────────────────────────────────────────────────────────

let backdropEl = null;
let modalEl    = null;
let analyzing  = false;
let _analysisProfileId = null;
let vpListeners = [];

function buildModal() {
    backdropEl = document.createElement('div');
    backdropEl.id = 'csi-backdrop';
    backdropEl.addEventListener('click', closeModal);
    document.documentElement.appendChild(backdropEl);

    modalEl = document.createElement('div');
    modalEl.id = 'csi-modal';
    modalEl.innerHTML = `
  <div class="csi-header">
    <div class="csi-title">
      <span class="csi-icon"><i class="fa-solid fa-syringe"></i></span>
      CardInject Pro
    </div>
    <button class="csi-x" id="csi-x">×</button>
  </div>

  <div class="csi-charbar">
    <i class="fa-solid fa-user csi-char-ico"></i>
    <select class="csi-char-sel" id="csi-char-sel"></select>
    <span class="csi-pill" id="csi-pill" style="display:none"></span>
  </div>

  <div class="csi-top">
    <button class="csi-analyze-btn" id="csi-analyze">
      <i class="fa-solid fa-wand-magic-sparkles"></i> AI로 캐시트 분석하기
    </button>
    <p class="csi-status" id="csi-status"></p>
  </div>

  <div class="csi-sep"></div>
  <div class="csi-list" id="csi-list"></div>

  <div class="csi-sep"></div>
  <p class="csi-hint">기존 프리셋은 그대로 두고 활성 카테고리만 전송 요청에 추가합니다.</p>

  <div class="csi-foot">
    <button class="csi-ghost" id="csi-reset"><i class="fa-solid fa-rotate-left"></i> 초기화</button>
    <div style="display:flex;gap:8px">
      <button class="csi-sec" id="csi-save"><i class="fa-solid fa-floppy-disk"></i> 저장</button>
      <button class="csi-pri" id="csi-apply"><i class="fa-solid fa-check"></i> 주입 적용</button>
    </div>
  </div>`;

    document.documentElement.appendChild(modalEl);

    modalEl.querySelector('#csi-x').onclick       = closeModal;
    modalEl.querySelector('#csi-analyze').onclick  = doAnalyze;
    modalEl.querySelector('#csi-apply').onclick    = async () => { await applyInjections(); setStatus('✓ 주입 적용 완료!', 'ok'); };
    modalEl.querySelector('#csi-save').onclick     = async () => { await save(); setStatus('✓ 저장됐어요.', 'ok'); toast('info', '설정이 저장됐어요.'); };
    modalEl.querySelector('#csi-reset').onclick    = doReset;
    modalEl.querySelector('#csi-char-sel').onchange = e => {
        ensureGlobalSettings().selectedCharIdx = parseInt(e.target.value);
        save();
        // 캐릭터 전환 → 그 캐릭터의 카테고리 목록으로 다시 렌더링
        const s = ensureSettings();
        const pill = modalEl.querySelector('#csi-pill');
        pill.textContent = `${s.categories.length}개`;
        pill.style.display = s.categories.length ? '' : 'none';
        render();
    };
}

function populateCharSel() {
    const sel = modalEl?.querySelector('#csi-char-sel');
    if (!sel) return;
    const chars = getAllChars(), cur = getSelectedIdx();
    console.log('[CSI] populateCharSel — 현재 감지:', chars[cur]?.name, '(idx', cur, ') | this_chid:', window.this_chid, '| ctx.characterId:', getCtx()?.characterId);
    sel.innerHTML = chars.length
        ? chars.map((c, i) => `<option value="${i}" ${i===cur?'selected':''}>${esc(c.name||`캐릭터${i+1}`)}</option>`).join('')
        : '<option value="">캐릭터 없음</option>';
}

function openModal() {
    if (!backdropEl) buildModal();

    // 항상 ST의 현재 캐릭터로 동기화
    const curId = _getCurrentCharId();
    if (curId != null) {
        ensureGlobalSettings().selectedCharIdx = curId;
    }

    populateCharSel();
    const s = ensureSettings();
    const pill = modalEl.querySelector('#csi-pill');
    pill.textContent = `${s.categories.length}개`;
    pill.style.display = s.categories.length ? '' : 'none';

    backdropEl.style.display = 'block';
    modalEl.style.display    = 'flex';
    positionModal();

    const reposition = () => positionModal();
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reposition);
        window.visualViewport.addEventListener('scroll', reposition);
        vpListeners = [reposition];
    }
    render();
}

function closeModal() {
    if (backdropEl) backdropEl.style.display = 'none';
    if (modalEl)    modalEl.style.display    = 'none';
    if (window.visualViewport && vpListeners.length) {
        vpListeners.forEach(fn => {
            window.visualViewport.removeEventListener('resize', fn);
            window.visualViewport.removeEventListener('scroll', fn);
        });
        vpListeners = [];
    }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

async function doAnalyze() {
    if (analyzing) return;
    const idx = getSelectedIdx(), sheet = getSheet(idx);
    if (!sheet) { setStatus('캐릭터를 선택해주세요.', 'err'); return; }
    if (!Object.values(sheet).join('').trim()) { setStatus('캐릭터 시트가 비어있어요.', 'err'); return; }

    const targetSettings = ensureSettings();
    analyzing = true;
    const btn = modalEl.querySelector('#csi-analyze');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 분석 중...';
    setStatus('선택한 분석용 연결 프로필로 분석 중...', 'load');

    try {
        const raw   = await callGenerate(buildPrompt(sheet));
        const clean = raw.replace(/```(?:json)?\n?/g,'').replace(/```/g,'').trim();
        const cats  = JSON.parse(clean).categories;
        if (!Array.isArray(cats)||!cats.length) throw new Error('카테고리 추출 실패');

        const s = targetSettings;
        s.categories = cats.map(c => {
            const pos = _resolvePosition(c.suggested_position);
            return {
                key:         c.key || Math.random().toString(36).slice(2),
                name:        c.name || 'Category',
                content:     c.content || '',
                importance:  c.importance || 'medium',
                position:    (c.suggested_position in POSITIONS || c.suggested_position in POSITION_ALIASES) ? c.suggested_position : 'sys_top',
                customDepth: pos.depth,  // suggested depth를 초기값으로
                enabled:     true,
                expanded:    false,
            };
        });
        await save();

        render();
        const pill = modalEl.querySelector('#csi-pill');
        const shownCount = ensureSettings().categories.length;
        pill.textContent = `${shownCount}개`;
        pill.style.display = shownCount ? '' : 'none';
        setStatus(`✓ ${cats.length}개 카테고리 분석 완료!`, 'ok');
    } catch (e) {
        console.error('[CSI]', e);
        setStatus(`실패: ${e.message}`, 'err');
    } finally {
        analyzing = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI로 캐시트 분석하기';
    }
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
    const container = modalEl?.querySelector('#csi-list');
    if (!container) return;
    const s = ensureSettings(), cats = s.categories;

    if (!cats.length) {
        container.innerHTML = `
          <div class="csi-empty">
            <i class="fa-solid fa-scroll"></i>
            <p>아직 분석된 카테고리가 없어요.<br>위 버튼으로 분석해보세요!</p>
          </div>`;
        return;
    }

    container.innerHTML = cats.map((c, i) => {
        const pos = _resolvePosition(c.position);
        const showDepth = pos.type === PT.IN_CHAT && c.position !== 'with_note'; // with_note는 자동감지라 수동입력 숨김
        return `
      <div class="csi-card ${c.enabled?'':'csi-off'}" data-i="${i}">
        <div class="csi-card-top">
          <div class="csi-card-left">
            <span class="csi-imp csi-imp-${c.importance}">${impLabel(c.importance)}</span>
            <span class="csi-cname">${esc(c.name)}</span>
          </div>
          <div class="csi-card-right">
            <button class="csi-chevron" data-i="${i}"><i class="fa-solid fa-chevron-${c.expanded?'up':'down'}"></i></button>
            <label class="csi-tog">
              <input type="checkbox" class="csi-chk" data-i="${i}" ${c.enabled?'checked':''}>
              <span class="csi-knob"></span>
            </label>
          </div>
        </div>
        ${c.expanded?`
        <div class="csi-textarea-wrap">
          <textarea class="csi-ta" data-i="${i}">${esc(c.content)}</textarea>
        </div>`:''}
        <div class="csi-card-body">
          <div class="csi-row">
            <span class="csi-lbl">위치</span>
            <select class="csi-sel csi-pos-sel" data-i="${i}">
              ${Object.entries(POSITIONS).map(([k,v])=>`<option value="${k}" ${c.position===k || POSITION_ALIASES[c.position]===k?'selected':''}>${v.label}</option>`).join('')}
              ${_presetRelOptionsHtml(c.position)}
            </select>
          </div>
          ${showDepth?`
          <div class="csi-row csi-depth-row">
            <span class="csi-lbl">Depth</span>
            <input class="csi-num csi-depth-inp" type="text" inputmode="numeric"
                   pattern="[0-9]*" data-i="${i}"
                   value="${c.customDepth ?? pos.depth}">
            <span class="csi-hint">위로 몇 번째 메시지</span>
          </div>`:''}
          ${c.position === 'with_note' ? `
          <div class="csi-row">
            <span class="csi-lbl">방식</span>
            <span class="csi-hint">전송 요청의 작가노트 뒤에 추가합니다. 찾지 못하면 작가노트 depth를 사용합니다.</span>
          </div>`:''}
        </div>
      </div>`;
    }).join('');

    // 이벤트 바인딩
    container.querySelectorAll('.csi-chevron').forEach(b => b.addEventListener('click', e => {
        const i=+e.currentTarget.dataset.i;
        s.categories[i].expanded = !s.categories[i].expanded;
        render();
    }));

    container.querySelectorAll('.csi-chk').forEach(inp => inp.addEventListener('change', async e => {
        const i=+e.target.dataset.i;
        s.categories[i].enabled = e.target.checked;
        await save();
        e.target.closest('.csi-card').classList.toggle('csi-off', !e.target.checked);
    }));

    container.querySelectorAll('.csi-pos-sel').forEach(sel => sel.addEventListener('change', async e => {
        const i=+e.target.dataset.i;
        const newPos = e.target.value;
        s.categories[i].position = newPos;
        // depth를 새 위치의 기본값으로 업데이트 (프리셋 기준 위치는 depth 개념 없음)
        if (POSITIONS[newPos]) s.categories[i].customDepth = POSITIONS[newPos].depth;
        // 강도 배지도 새 위치에 맞춰 자동으로 갱신
        s.categories[i].importance = _importanceForPosition(newPos);
        await save();
        render();
    }));

    // depth 입력 — blur + change 이벤트 둘 다 (모바일 호환)
    container.querySelectorAll('.csi-depth-inp').forEach(inp => {
        const handler = async e => {
            const i = +e.target.dataset.i;
            const val = parseInt(e.target.value);
            if (!isNaN(val) && val >= 0) {
                s.categories[i].customDepth = val;
                await save();
            }
        };
        inp.addEventListener('change', handler);
        inp.addEventListener('blur',   handler);
    });

    container.querySelectorAll('.csi-note-offset').forEach(inp => {
        const handler = async e => {
            const i = +e.target.dataset.i;
            const val = parseInt(e.target.value);
            if (!isNaN(val)) {
                s.categories[i].noteOffset = val;
                await save();
                render(); // depth 미리보기 텍스트 갱신
            }
        };
        inp.addEventListener('change', handler);
        inp.addEventListener('blur',   handler);
    });

    container.querySelectorAll('.csi-ta').forEach(ta => ta.addEventListener('input', async e => {
        const i=+e.target.dataset.i;
        s.categories[i].content = e.target.value;
        await save();
    }));
}

function setStatus(msg, type) {
    const el = modalEl?.querySelector('#csi-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `csi-status${type?' csi-s-'+type:''}`;
    if (type==='ok') setTimeout(()=>{ if(el.textContent===msg) el.textContent=''; }, 3500);
}

async function doReset() {
    if (!confirm('초기화할까요?')) return;
    await clearInjections();
    const s=ensureSettings(); s.categories=[];
    await save(); render();
    if (modalEl) modalEl.querySelector('#csi-pill').style.display='none';
    setStatus('초기화 완료.','ok');
}

// ── Panel ─────────────────────────────────────────────────────────────────────
// 반드시 동기 함수 — await 없음, 어떤 에러가 나도 setupWand()까지 도달함

function setupPanel() {
    try {
        $('#extensions_settings').append(`
<div class="inline-drawer" id="csi-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b><i class="fa-solid fa-syringe" style="margin-right:6px"></i>CardInject Pro</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div style="padding:8px 0;display:flex;gap:8px">
      <button id="csi-p-open"  class="menu_button menu_button_icon" style="flex:1"><i class="fa-solid fa-syringe"></i> 열기</button>
      <button id="csi-p-apply" class="menu_button menu_button_icon" style="flex:1"><i class="fa-solid fa-check"></i> 주입 적용</button>
    </div>
    <div id="csi-profile-wrap" style="display:none;padding:4px 0 0">
      <div style="font-size:11px;color:#888;margin-bottom:4px;font-weight:600">캐시트 분석용 연결 프로필</div>
      <select id="csi-profile-sel" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid #ddd;border-radius:6px;background:#fff;box-sizing:border-box">
        <option value="">— 선택 —</option>
      </select>
    </div>
    <div id="csi-p-msg" style="font-size:12px;text-align:center;min-height:16px;padding:4px 0 6px;color:#666"></div>
  </div>
</div>`);
        $('#csi-p-open').on('click', openModal);
        $('#csi-p-apply').on('click', async () => {
            await applyInjections();
        });
        $(document).on('change', '#csi-profile-sel', function () {
            const id = $(this).val();
            if (!id) return;
            _analysisProfileId = id;
            ensureGlobalSettings().connectionProfileId = id;
            save();
            $('#csi-p-msg').text('✓ 분석용 연결 프로필 선택됨');
        });
        console.log('[CSI] 패널 완료 ✓');
    } catch (e) {
        console.error('[CSI] 패널 오류:', e);
    }
}

function setupWand() {
    try {
        $('#extensionsMenu').append(`
<div class="list-group-item flex-container flexGap5" id="csi-wand" title="CardInject Pro">
  <i class="fa-solid fa-syringe"></i><span>CardInject Pro</span>
</div>`);
        $('#csi-wand').on('click', () => {
            $('#extensionsMenu').closest('.popup').find('.popup_close').trigger('click');
            setTimeout(openModal, 80);
        });
        console.log('[CSI] 완드 완료 ✓');
    } catch (e) {
        console.error('[CSI] 완드 오류:', e);
    }
}

// API 로드 후 비동기로 프로필 목록 채우기 — 실패해도 패널에 영향 없음
async function loadProfilesIntoPanel() {
    try {
        const profiles = getConnectionProfiles();

        if (!profiles || !profiles.length) {
            console.log('[CSI] 연결 프로필 목록을 못 찾음 — 패널에서 숨김');
            return;
        }
        console.log('[CSI] 프로필 발견:', profiles.length + '개');

        const sel = document.querySelector('#csi-profile-sel');
        const wrap = document.querySelector('#csi-profile-wrap');
        if (!sel || !wrap) return;

        // 기존 analysisProfileId 저장값도 자동 이전해 선택을 유지함.
        if (_analysisProfileId === null) {
            const globalSettings = ensureGlobalSettings();
            const saved = globalSettings.connectionProfileId ?? globalSettings.analysisProfileId;
            if (saved) _analysisProfileId = saved;
        }
        const curVal = profiles.some(p => p.id === _analysisProfileId)
            ? _analysisProfileId
            : profiles[0].id;

        sel.innerHTML = '';
        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id; opt.textContent = p.name;
            if (p.id === curVal) opt.selected = true;
            sel.appendChild(opt);
        });
        _analysisProfileId = curVal;
        ensureGlobalSettings().connectionProfileId = curVal;
        save();
        wrap.style.display = '';
        console.log('[CSI] 프로필 패널 업데이트 완료');
    } catch (e) {
        console.warn('[CSI] 프로필 로드 실패 (무시):', e.message);
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

jQuery(() => {
    if (!_csiRuntimeActive) return;
    _installFetchHook();
    ensureSettings();
    setupPanel();
    setupWand();
    (async () => {
        try {
            await getApi();
            if (!_csiRuntimeActive) return;
            await loadProfilesIntoPanel();
            if (!_csiRuntimeActive) return;
            const fn = _findSetPrompt();
            if (fn) _doInject(fn);
            console.log('[CSI] 완전 로드 ✓');
        } catch (e) {
            console.error('[CSI] 초기화 오류:', e);
        }
    })();
});

// ── Main-request verification + request-only injection ─────────────────────
let _csiChatSnapshot = [];
const _csiConfirmedRequests = new Set();
const _csiPreparedPrompts = new Map();
const _csiResolvedCategories = new Map();
let _csiRequestHooksRegistered = false;

function _csiEnabledCategories() {
    return (ensureSettings().categories ?? []).filter(cat => cat.enabled && cat.content?.trim());
}

function _csiNames() {
    const ctx = getCtx();
    return { charName: ctx?.name2 || getAllChars()[getSelectedIdx()]?.name || '',
        userName: ctx?.name1 || window.name1 || '' };
}

function _csiResetRequestState() {
    _csiChatSnapshot = [];
    _csiConfirmedRequests.clear();
    _csiPreparedPrompts.clear();
    _csiResolvedCategories.clear();
}

function _installPromptCapture() {
    if (!_csiRuntimeActive) return;
    const manager = _api?.promptManager ?? getCtx()?.promptManager;
    if (!manager || typeof manager.preparePrompt !== 'function'
        || hasHookOwner(manager.preparePrompt, PROMPT_CAPTURE_OWNER)) return;
    const original = manager.preparePrompt;
    const wrapped = function (...args) {
        const result = original.apply(this, args);
        if (_csiRuntimeActive && result?.identifier && typeof result.content === 'string') {
            const key = String(result.identifier);
            const variants = _csiPreparedPrompts.get(key) ?? new Set();
            variants.add(result.content);
            if (variants.size > 8) variants.delete(variants.values().next().value);
            _csiPreparedPrompts.set(key, variants);
        }
        return result;
    };
    Object.defineProperty(wrapped, '__csiPreparedCapture', { value: true });
    markHookOwner(wrapped, original, PROMPT_CAPTURE_OWNER);
    manager.preparePrompt = wrapped;
}

function _csiRememberRequest(body) {
    const fingerprint = requestFingerprint(body);
    if (!fingerprint) return;
    _csiConfirmedRequests.add(fingerprint);
    if (_csiConfirmedRequests.size > 8) _csiConfirmedRequests.delete(_csiConfirmedRequests.values().next().value);
}

function _csiResolvedCats(names) {
    return _csiEnabledCategories().map((cat, index) => {
        const cacheKey = JSON.stringify([cat.key || index, cat.content, names]);
        if (!_csiResolvedCategories.has(cacheKey)) {
            _csiResolvedCategories.set(cacheKey, resolveContent(cat.content, names, _api?.substituteParams));
        }
        const pos = _resolvePosition(cat.position);
        const chatPosition = pos.type === PT.IN_CHAT;
        return { ...cat,
            position: chatPosition ? 'chat_recent' : cat.position,
            customDepth: chatPosition ? Math.max(0, Number(cat.customDepth ?? pos.depth) || 0) : cat.customDepth,
            resolvedContent: _csiResolvedCategories.get(cacheKey) };

    });
}

function _csiApplyOutboundRequest(body, source, stack) {
    if (!_csiRuntimeActive) return null;
    const ctx = getCtx(), names = _csiNames();
    const decision = mainRequestDecision(body, stack, {
        chat: ctx?.chat, snapshot: _csiChatSnapshot, names, confirmed: _csiConfirmedRequests,
    });
    if (!decision.eligible) {
        console.debug('[CSI] 전송 요청 제외', { source, type: decision.type, reason: decision.reason });
        return null;
    }
    // A concurrent/hung analysis flag does not block a positively confirmed
    // main request. Its custom-request/raw sender is independently excluded.
    _csiRememberRequest(body);
    const cats = _csiResolvedCats(names);
    if (!cats.length) return null;
    const metadata = ctx?.chatMetadata ?? ctx?.chat_metadata ?? {};
    const report = applyCategoryInjections(body, cats, {
        names, presets: _getPresetPrompts(), prepared: _csiPreparedPrompts,
        noteText: _getAuthorNoteText().split(CSI_NOTE_MARKER)[0],
        noteDepth: Number.isFinite(Number(metadata.note_depth)) ? Number(metadata.note_depth) : 4,
        substitute: _api?.substituteParams,
    });
    _csiRememberRequest(body);
    if (report.missing.length) console.warn('[CSI] 주입 위치 대체', report.missing);
    if (source === 'fetch-final') {
        console.info('[CSI] 전송 직전 카테고리 검사', {
            type: decision.type || '(없음)', requestPath: decision.requestPath,
            mainRequestMatched: true, fallbackUsed: report.missing.length > 0,
            expected: cats.map((cat, index) => String(cat.key || index)),
            categories: report.categories, fallback: report.missing,
        });
    }
    return report;
}

export function _registerInjectionRequestHooks() {
    if (!_csiRuntimeActive || _csiRequestHooksRegistered) return;
    const ctx = getCtx();
    const source = _api?.eventSource ?? ctx?.eventSource;
    const types = _api?.event_types ?? ctx?.eventTypes ?? ctx?.event_types;
    if (!source || !types) return;
    const on = (key, handler) => {
        if (!types[key]) return;
        const guarded = (...args) => { if (_csiRuntimeActive) return handler(...args); };
        source.on(types[key], guarded);
        _csiRequestHandlers.push({ source, event: types[key], handler: guarded });
    };
    on('GENERATION_STARTED', (_type, options = {}, dryRun = false) => {
        if (dryRun || options?.dryRun || _type?.dryRun) return;
        _csiResetRequestState();
        _csiChatSnapshot = chatEvidence(getCtx()?.chat);
        _installFetchHook();
        _installPromptCapture();
        const fn = _findSetPrompt();
        if (fn) _doInject(fn);
    });
    on('CHAT_COMPLETION_SETTINGS_READY', payload => {
        if (payload?.dryRun) return;
        const stack = new Error().stack ?? '';
        _installFetchHook();
        _csiApplyOutboundRequest(payload, 'settings-ready', stack);
    });
    for (const key of ['GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED']) {
        on(key, _csiResetRequestState);
    }
    let lastCharId = _getCurrentCharId();
    const onCharacterChanged = () => {
        const current = _getCurrentCharId();
        if (current === lastCharId) return;
        lastCharId = current;
        ensureGlobalSettings().selectedCharIdx = current;
        _csiResetRequestState();
        const fn = _findSetPrompt();
        if (fn) _doInject(fn);
        if (modalEl && modalEl.style.display !== 'none') {
            populateCharSel();
            render();
            const pill = modalEl.querySelector('#csi-pill');
            if (pill) {
                const count = ensureSettings().categories.length;
                pill.textContent = `${count}개`;
                pill.style.display = count ? '' : 'none';
            }
        }
        save();
    };
    on('CHARACTER_SELECTED', onCharacterChanged);
    on('CHAT_CHANGED', onCharacterChanged);
    on('GENERATE_BEFORE_COMBINE_PROMPTS', () => {
        _installFetchHook();
        _installPromptCapture();
        const fn = _findSetPrompt();
        if (fn) _doInject(fn);
    });
    _csiRequestHooksRegistered = true;
}

export function _installFetchHook() {
    if (!_csiRuntimeActive || typeof window.fetch !== 'function'
        || hasHookOwner(window.fetch, FETCH_HOOK_OWNER)) return;
    const previousFetch = window.fetch;
    const originalFetch = previousFetch.bind(window);
    const wrapped = async function csiGenerationFetch(url, options, ...rest) {
        if (!_csiRuntimeActive) return originalFetch(url, options, ...rest);
        const requestInput = typeof Request !== 'undefined' && url instanceof Request;
        const address = typeof url === 'string' ? url : String(url?.url ?? url?.href ?? '');
        const method = String(options?.method ?? (requestInput ? url.method : '')).toUpperCase();
        if (method === 'POST' && /\/api\/backends\/chat-completions\/generate(?:[?#]|$)/.test(address)) {
            const stack = new Error().stack ?? '';
            try {
                const serialized = options?.body ?? (requestInput ? await url.clone().text() : null);
                if (typeof serialized === 'string') {
                    const body = JSON.parse(serialized);
                    const report = _csiApplyOutboundRequest(body, 'fetch-final', stack);
                    if (report?.changed) options = { ...options, body: JSON.stringify(body) };
                }
            } catch (error) {
                console.warn('[CSI] 전송 직전 주입 처리 실패 — 생성은 계속합니다.', error);
            }
        }
        return originalFetch(url, options, ...rest);
    };
    Object.defineProperty(wrapped, '__csiGenerationHook', { value: true });
    markHookOwner(wrapped, previousFetch, FETCH_HOOK_OWNER);
    window.fetch = wrapped;
    window._csiHooked = true;
    console.debug('[CSI] 본생성 전송 훅 연결');
}

export function onEnable() {
    _csiRuntimeActive = true;
    _installFetchHook();
    _installPromptCapture();
    _registerInjectionRequestHooks();
    const fn = _findSetPrompt();
    if (fn) _doInject(fn);
}

export function onDisable() {
    _csiRuntimeActive = false;
    _csiResetRequestState();
    for (const { source, event, handler } of _csiRequestHandlers.splice(0)) {
        if (typeof source.removeListener === 'function') source.removeListener(event, handler);
        else if (typeof source.off === 'function') source.off(event, handler);
    }
    _csiRequestHooksRegistered = false;
    const settings = ensureGlobalSettings(), fn = _findSetPrompt();
    for (const id of settings.activeKeys.filter(_csiOwnPromptId)) {
        try { fn?.(id, '', PT.IN_PROMPT, 0, false, 0); } catch (_) {}
        _directWrite(id, '', PT.IN_PROMPT, 0);
    }
    settings.activeKeys = [];
    _applyNoteInjection([]);
    // Leave the shared wrapper chain intact; inactive wrappers just forward.
}
