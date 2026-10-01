// Request-only injection helpers. No saved preset or chat records are mutated.
const MAIN_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const ALIASES = { sys_bottom: 'sys_top', after_char: 'sys_top', chat_top: 'sys_top', chat_deep: 'chat_recent', chat_mid: 'chat_recent', chat_bottom: 'chat_recent', pre_assist: 'with_note' };
export const normalizeText = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
export const messageText = message => typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n')
        : String(message?.mes ?? '');

export function callerKind(stack) {
    const frames = String(stack ?? '').split('\n');
    const sender = frames.findIndex(frame => /\bsendOpenAIRequest\b/.test(frame));
    if (sender < 0) return /custom-request\.js|\b(?:generateRawData|generateRaw|generateQuietPrompt)\b/.test(String(stack ?? '')) ? 'auxiliary' : 'unknown';
    for (const frame of frames.slice(sender + 1)) {
        if (/\b(?:generateRawData|generateRaw|generateQuietPrompt|processRequest|sendRequest)\b|custom-request\.js/.test(frame)) return 'auxiliary';
        if (/\b(?:sendGenerationRequest|finishGenerating)\b/.test(frame)) return 'main';
    }
    return 'unknown';
}

export function requestFingerprint(body) {
    return Array.isArray(body?.messages) ? JSON.stringify([body.type ?? '', body.model ?? '', body.messages]) : '';
}

export function chatEvidence(chat) {
    if (!Array.isArray(chat)) return [];
    let latest;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system || message.is_hidden) continue;
        latest ??= message;
        if (message.is_user || message.role === 'user') { latest = message; break; }
    }
    if (!latest) return [];
    const values = [messageText(latest), latest.extra?.display_text, latest.extra?.ttotto_source_text,
        latest.extra?.original_text, latest.extra?.original_mes, latest.extra?.source_text,
        latest.extra?.translation?.original, latest.extra?.translator?.original,
        latest.extra?.feather_active?.source];
    const role = latest.is_user || latest.role === 'user' ? 'user' : 'assistant';
    return [...new Set(values.filter(value => typeof value === 'string' && value.trim()))].map(text => ({ role, text: normalizeText(text) }));
}

export function mainRequestDecision(body, stack, { chat, snapshot = [], names = {}, confirmed = new Set() } = {}) {
    const type = String(body?.type ?? '').trim().toLowerCase();
    const kind = callerKind(stack);
    if (kind === 'auxiliary') return { eligible: false, reason: 'auxiliary_request_path', type };
    const certified = confirmed.has(requestFingerprint(body));
    if (type && !MAIN_TYPES.has(type) && type !== 'quiet') return { eligible: false, reason: 'auxiliary_type', type };
    if (kind !== 'main' && !certified) return { eligible: false, reason: 'main_request_path_not_confirmed', type };
    if (!Array.isArray(body?.messages)) return { eligible: false, reason: 'no_messages', type };
    const matches = [...snapshot, ...chatEvidence(chat)].some(item => body.messages.some(message => {
        if (message?.role !== item.role) return false;
        const text = normalizeText(messageText(message));
        const name = item.role === 'user' ? names.userName : names.charName;
        return text === item.text || Boolean(name) && text === `${name}: ${item.text}`;
    }));
    if (!matches) return { eligible: false, reason: 'main_chat_turn_not_matched', type };
    return { eligible: true, type, requestPath: kind === 'main' ? 'st-main-generation' : 'confirmed-main-request' };
}

export function resolveContent(value, names = {}, substitute) {
    let text = String(value ?? '');
    if (typeof substitute === 'function') {
        try { const result = substitute(text); if (typeof result === 'string') return result; } catch (_) { /* name-only fallback */ }
    }
    return text.replace(/\{\{\/\/[^}]*\}\}/g, '')
        .replace(/\{\{char\}\}/gi, names.charName ?? '').replace(/\{\{user\}\}/gi, names.userName ?? '');
}

function textSpan(text, candidate) {
    const needle = String(candidate).trim();
    if (!needle) return null;
    const exact = text.indexOf(needle);
    if (exact >= 0) return text.indexOf(needle, exact + 1) < 0
        ? { start: exact, end: exact + needle.length } : { ambiguous: true };
    let normalized = '';
    const starts = [], ends = [];
    for (let i = 0; i < text.length; i++) {
        if (/\s/u.test(text[i])) {
            if (normalized.endsWith(' ')) ends[ends.length - 1] = i + 1;
            else { normalized += ' '; starts.push(i); ends.push(i + 1); }
        } else { normalized += text[i]; starts.push(i); ends.push(i + 1); }
    }
    const target = normalizeText(needle), offset = normalized.indexOf(target);
    if (offset < 0) return null;
    if (normalized.indexOf(target, offset + 1) >= 0) return { ambiguous: true };
    return { start: starts[offset], end: ends[offset + target.length - 1] };
}

function findSpan(messages, candidates, role = 'system') {
    for (const candidate of [...new Set(candidates.filter(value => typeof value === 'string' && value.trim()))]) {
        const found = [];
        messages.forEach((message, index) => {
            if (role && message.role !== role && !(role === 'system' && message.role === 'developer')) return;
            const parts = typeof message.content === 'string' ? [{ text: message.content }] : Array.isArray(message.content) ? message.content : [];
            parts.forEach((part, partIndex) => {
                if (typeof part?.text !== 'string') return;
                const span = textSpan(part.text, candidate);
                if (span?.ambiguous) found.push(null, null);
                else if (span) found.push({ index, partIndex, ...span });
            });
        });
        if (found.length === 1) return found[0];
    }
    return null;
}

function insertAtSpan(messages, span, after, content, appendToText = false) {
    const original = messages[span.index], offset = after ? span.end : span.start;
    if (appendToText) {
        if (typeof original.content === 'string') original.content = `${original.content.slice(0, offset)}\n\n${content}${original.content.slice(offset)}`;
        else {
            const part = original.content[span.partIndex];
            original.content[span.partIndex] = { ...part, text: `${part.text.slice(0, offset)}\n\n${content}${part.text.slice(offset)}` };
        }
        return span.index;
    }
    let before, following;
    if (typeof original.content === 'string') { before = original.content.slice(0, offset); following = original.content.slice(offset); }
    else {
        const part = original.content[span.partIndex], left = part.text.slice(0, offset), right = part.text.slice(offset);
        before = [...original.content.slice(0, span.partIndex), ...(left ? [{ ...part, text: left }] : [])];
        following = [...(right ? [{ ...part, text: right }] : []), ...original.content.slice(span.partIndex + 1)];
    }
    const nonempty = value => typeof value === 'string' ? Boolean(value.trim()) : value.length > 0;
    const replacement = nonempty(before) ? [{ ...original, content: before }] : [];
    const index = span.index + replacement.length;
    replacement.push({ role: 'system', content });
    if (nonempty(following)) replacement.push({ ...original, content: following });
    messages.splice(span.index, 1, ...replacement);
    return index;
}

function depthIndex(messages, rawDepth) {
    const depth = Math.max(0, Math.floor(Number(rawDepth) || 0));
    if (!depth) return messages.length;
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!['user', 'assistant'].includes(messages[i]?.role)) continue;
        if (++count >= depth) return i;
    }
    return messages.findIndex(message => ['user', 'assistant'].includes(message?.role)) >= 0
        ? messages.findIndex(message => ['user', 'assistant'].includes(message?.role)) : messages.length;
}

function positionAnchor(messages, position, { presets, prepared, names, substitute, noteText }) {
    if (position.startsWith('preset_')) {
        const after = position.startsWith('preset_after_'), identifier = position.replace(/^preset_(after|before)_/, '');
        const prompt = presets.find(item => String(item.identifier) === identifier);
        const raw = resolveContent(prompt?.content, names, substitute);
        const candidates = [...(prepared.get(identifier) ?? [])].reverse();
        if (raw && !raw.includes('{{')) candidates.push(raw);
        const span = prompt && prompt.enabledInPreset !== false ? findSpan(messages, candidates, prompt.role || 'system') : null;
        return { span, after, reason: span ? undefined : !prompt ? 'preset_entry_missing'
            : prompt.enabledInPreset === false ? 'preset_disabled' : 'preset_content_missing_or_ambiguous' };
    }
    if (position === 'with_note') {
        const raw = resolveContent(noteText, names, substitute);
        const candidates = [...(prepared.get('authorNote') ?? []), ...(!raw.includes('{{') ? [raw] : [])];
        const span = findSpan(messages, candidates, null);
        return { span, after: true, reason: span ? undefined : 'author_note_depth_fallback' };
    }
    return {};
}

export function applyCategoryInjections(body, categories, { names = {}, presets = [], prepared = new Map(), noteText = '', noteDepth = 4, substitute } = {}) {
    if (!Array.isArray(body?.messages)) return { categories: [], missing: [], changed: false };
    // Outbound message objects are sometimes shared with other handlers.
    const messages = body.messages.map(message => ({ ...message,
        content: Array.isArray(message.content) ? message.content.map(part => ({ ...part })) : message.content }));
    const report = [], missing = [], groups = new Map(), allocated = new Map();
    const anchorOptions = { presets, prepared, names, substitute, noteText };
    (categories ?? []).forEach((cat, ordinal) => {
        if (!cat?.enabled || !cat.content?.trim()) return;
        const key = String(cat.key || ordinal), position = ALIASES[cat.position] || cat.position || 'sys_top';
        const content = String(cat.resolvedContent ?? resolveContent(cat.content, names, substitute)).trim();
        if (!content) return;
        const prior = allocated.get(content) || 0;
        let occurrences = 0;
        for (const message of messages) {
            // AN can have a user/assistant role; other categories use system.
            if (!['system', 'developer'].includes(message.role) && position !== 'with_note') continue;
            occurrences += messageText(message).split(content).length - 1;
        }
        allocated.set(content, prior + 1);
        if (occurrences > prior) {
            // A second pass must retain a warning when an earlier pass used
            // fallback placement; finding the content alone proves delivery.
            const { reason } = positionAnchor(messages, position, anchorOptions);
            const entry = { key, position, status: reason ? 'fallback' : 'present' };
            if (reason) { entry.reason = reason; missing.push(entry); }
            report.push(entry); return;
        }
        const groupKey = position === 'chat_recent' ? `${position}:${Math.max(0, Number(cat.customDepth ?? 2) || 0)}` : position;
        const group = groups.get(groupKey) ?? { position, depth: cat.customDepth ?? 2, items: [] };
        group.items.push({ key, content }); groups.set(groupKey, group);
    });
    let changed = false;
    // Preserve category order within identical positions. System injections
    // never count as historical chat turns, so no depth sorting is required.
    const ordered = [...groups.values()];
    for (const group of ordered) {
        const content = group.items.map(item => item.content).join('\n\n');
        let index, reason;
        if (group.position.startsWith('preset_')) {
            const { span, after, reason: fallbackReason } = positionAnchor(messages, group.position, anchorOptions);
            if (span) index = insertAtSpan(messages, span, after, content);
            else reason = fallbackReason;
        } else if (group.position === 'with_note') {
            const { span } = positionAnchor(messages, group.position, anchorOptions);
            if (span) index = insertAtSpan(messages, span, true, content, true);
            else { index = depthIndex(messages, noteDepth); messages.splice(index, 0, { role: 'system', content }); reason = 'author_note_depth_fallback'; }
        } else if (group.position === 'chat_recent') {
            index = depthIndex(messages, group.depth); messages.splice(index, 0, { role: 'system', content });
        } else { index = 0; messages.splice(0, 0, { role: 'system', content }); }
        if (index === undefined) { index = messages.length; messages.push({ role: 'system', content }); }
        changed = true;
        for (const item of group.items) {
            const entry = { key: item.key, position: group.position, status: reason ? 'fallback' : 'inserted', index };
            if (reason) { entry.reason = reason; missing.push(entry); }
            report.push(entry);
        }
    }
    if (changed) body.messages = messages;
    return { categories: report, missing, changed };
}
