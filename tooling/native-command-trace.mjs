/** @typedef {(this: unknown, ...args: unknown[]) => unknown} Method */
/** @typedef {{kind?: string, status?: string, durationMs?: number, errorCode?: string, index?: number, modelId?: string, finishReason?: string, usage?: Record<string, number>, contentTypes?: string[], toolNames?: string[], content?: string, contentLength?: number, pageTitle?: string|null, truncated?: boolean, requestedUrl?: string, requestedUrlMetadata?: UrlMetadata, sourceUrl?: string, pageKind?: string, finalUrl?: null|string, finalUrlMetadata?: UrlMetadata, limitations?: string[], evidence?: string, sources?: unknown, page?: unknown, [key: string]: unknown}} TraceEvent */
/** @typedef {{sdkInvocations: number, researchCalls: number, generations: TraceEvent[], research: TraceEvent[], budgetRejections: TraceEvent[], guardRejections: TraceEvent[]}} Trace */
/** @typedef {{model: Method, search: Method, readPage: Method}} Methods */
/** @typedef {{providerConnections: {model: Method}, commandResearch: {search: Method, readPage: Method}}} NativePlugin */
/** @typedef {{plugins?: {plugins?: Record<string, NativePlugin>}}} NativeApp */
/** @typedef {{hash: string, length: number}} UrlMetadata */
/** @typedef {(methodName: 'search'|'readPage', requested: unknown, captureUrls: string[], result: unknown, durationMs: number, urlMetadata: (value: unknown) => UrlMetadata, addProvenance: (event: TraceEvent, page: Record<string, unknown>, source: Record<string, unknown>, urls: string[], hashUrl: (value: unknown) => UrlMetadata) => void) => TraceEvent} SuccessEvent */
/** @typedef {{trace: Trace, originals: Methods, wrapped: Partial<Methods>, connections: NativePlugin['providerConnections'], research: NativePlugin['commandResearch'], modelWrappers: Map<{modelId?: unknown, doGenerate: Method}, {original: Method, wrapped: Method}>}} TraceState */

/** Build an in-memory installer for the running development-vault plugin. */
/** @param {string|string[]} captureUrls @param {string} expectedModelId @param {string} traceKey */
export function buildNativeTraceInstallEval(captureUrls, expectedModelId, traceKey) {
  const urls = Array.isArray(captureUrls) ? captureUrls : [captureUrls];
  return `(${installNativeTrace.toString()})(window, app, ${JSON.stringify(urls)}, ${JSON.stringify(expectedModelId)}, ${JSON.stringify(traceKey)}, ${researchSuccessEvent.toString()}, ${unsupportedUrlMetadata.toString()}, ${isHttpsUrl.toString()}, ${addPageProvenance.toString()})`;
}

/** Read only the sanitized trace retained by the installer. */
/** @param {string} traceKey */
export function buildNativeTraceReadEval(traceKey) {
  return `JSON.stringify(window[${JSON.stringify(traceKey)}]?.trace ?? null)`;
}

/** Restore methods only when this installer still owns the current wrapper. */
/** @param {string} traceKey */
export function buildNativeTraceRestoreEval(traceKey) {
  return `(${restoreNativeTrace.toString()})(window, ${JSON.stringify(traceKey)})`;
}

/** @param {Record<string, unknown>} root @param {NativeApp} app @param {string[]} captureUrls @param {string} expectedModelId @param {string} traceKey @param {SuccessEvent} successEvent @param {(value: unknown) => UrlMetadata} urlMetadata @param {(value: string) => boolean} isHttpsUrl @param {(event: TraceEvent, page: Record<string, unknown>, source: Record<string, unknown>, urls: string[], hashUrl: (value: unknown) => UrlMetadata) => void} addProvenance */
function installNativeTrace(
  root,
  app,
  captureUrls,
  expectedModelId,
  traceKey,
  successEvent,
  urlMetadata,
  isHttpsUrl,
  addProvenance,
) {
  const captureUrlsValid =
    captureUrls.length > 0 && captureUrls.length <= 8 && captureUrls.every(isHttpsUrl);
  const plugin = app?.plugins?.plugins?.['abyss-tasks'];
  const connections = plugin?.providerConnections;
  const research = plugin?.commandResearch;
  const preflight = {
    pluginPresent: Boolean(plugin),
    modelSeam: typeof connections?.model === 'function',
    searchSeam: typeof research?.search === 'function',
    readPageSeam: typeof research?.readPage === 'function',
    sentinelAbsent: root[traceKey] === undefined,
    expectedModelIdProvided: expectedModelId.trim().length > 0,
    captureUrlsValid,
  };
  if (
    !captureUrlsValid ||
    !preflight.pluginPresent ||
    !preflight.modelSeam ||
    !preflight.searchSeam ||
    !preflight.readPageSeam ||
    !preflight.sentinelAbsent ||
    !preflight.expectedModelIdProvided
  )
    return { installed: false, preflight };
  if (!plugin || !connections || !research) return { installed: false, preflight };

  /** @type {Trace} */
  const trace = {
    sdkInvocations: 0,
    researchCalls: 0,
    generations: [],
    research: [],
    budgetRejections: [],
    guardRejections: [],
  };
  /** @type {Methods} */
  const originals = {
    model: connections.model,
    search: research.search,
    readPage: research.readPage,
  };
  /** @type {Partial<Methods>} */
  const wrapped = {};
  const modelWrappers = new Map();
  const allowedCodes = new Set([
    'cancelled',
    'timeout',
    'busy',
    'unavailable',
    'invalid-request',
    'invalid-response',
    'rate-limit',
    'too-large',
    'plan-storage',
    'plan-desktop',
    'plan-sign-in',
    'plan-permission',
    'plan-limit',
    'plan-revoke',
    'compatible-unavailable',
    'missing-key',
    'secret-storage',
    'authentication',
    'billing',
    'query-too-long',
    'PAGE_UNAVAILABLE',
  ]);
  /** @param {unknown} error */
  const errorCode = (error) => {
    if (typeof error !== 'object' || error === null || !('code' in error)) return 'unknown';
    return typeof error.code === 'string' && allowedCodes.has(error.code) ? error.code : 'unknown';
  };
  /** @param {number} start */
  const elapsed = (start) => Math.max(0, Math.round(performance.now() - start));
  /** @param {unknown} usage */
  const safeUsage = (usage) => {
    if (!usage || typeof usage !== 'object') return undefined;
    /** @type {Record<string, number>} */
    const result = {};
    const fields = /** @type {Record<string, unknown>} */ (usage);
    for (const key of ['inputTokens', 'outputTokens']) {
      const value = fields[key];
      let total;
      if (typeof value === 'number') total = value;
      else if (typeof value === 'object' && value !== null && 'total' in value) total = value.total;
      if (typeof total === 'number' && Number.isFinite(total)) result[key] = total;
    }
    const total = fields['totalTokens'];
    if (typeof total === 'number' && Number.isFinite(total)) result['totalTokens'] = total;
    return Object.keys(result).length === 0 ? undefined : result;
  };
  const maxContentEntries = 64;
  const maxRecordedEntries = 16;
  const contentTypeEnums = new Set([
    'text',
    'reasoning',
    'custom',
    'reasoning-file',
    'file',
    'tool-approval-request',
    'source',
    'tool-call',
    'tool-result',
  ]);
  const finishReasonEnums = new Set([
    'stop',
    'length',
    'content-filter',
    'tool-calls',
    'error',
    'interrupted',
    'other',
  ]);
  /** @param {unknown} params */
  const declaredToolNames = (params) => {
    const names = /** @type {Set<string>} */ (new Set());
    if (typeof params !== 'object' || params === null || !('tools' in params)) return names;
    const tools = params.tools;
    if (!Array.isArray(tools)) return names;
    for (const tool of tools.slice(0, maxContentEntries)) {
      if (
        typeof tool === 'object' &&
        tool !== null &&
        'type' in tool &&
        tool.type === 'function' &&
        'name' in tool &&
        typeof tool.name === 'string' &&
        tool.name.length <= 120
      )
        names.add(tool.name);
    }
    return names;
  };
  /** @param {unknown} content @param {Set<string>} declaredNames */
  const safeToolNames = (content, declaredNames) => {
    if (!Array.isArray(content)) return { names: [], unknownCount: 0, omittedCount: 0 };
    const names = [];
    let unknownCount = 0;
    let omittedCount = 0;
    for (const part of content.slice(0, maxContentEntries)) {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('type' in part) ||
        part.type !== 'tool-call' ||
        !('toolName' in part) ||
        typeof part.toolName !== 'string'
      )
        continue;
      if (declaredNames.has(part.toolName)) {
        if (names.length < maxRecordedEntries) names.push(part.toolName);
        else omittedCount++;
      } else unknownCount++;
    }
    return {
      names,
      unknownCount: Math.min(maxContentEntries, unknownCount),
      omittedCount: Math.min(maxContentEntries, omittedCount),
    };
  };
  /** @param {unknown} content */
  const contentTypeSummary = (content) => {
    if (!Array.isArray(content)) return { types: [], unknownCount: 0, omittedCount: 0, count: 0 };
    /** @type {string[]} */
    const types = [];
    let unknownCount = 0;
    for (const part of content.slice(0, maxContentEntries)) {
      if (typeof part !== 'object' || part === null || !('type' in part)) continue;
      const type = part.type;
      if (typeof type !== 'string' || !contentTypeEnums.has(type)) unknownCount++;
      else if (!types.includes(type) && types.length < maxRecordedEntries) types.push(type);
    }
    return {
      types,
      unknownCount: Math.min(maxContentEntries, unknownCount),
      omittedCount: Math.min(1_000_000, Math.max(0, content.length - maxContentEntries)),
      count: Math.min(1_000_000, content.length),
    };
  };
  const finishKeys = new Set([
    'state',
    'message',
    'coverage',
    'selection',
    'presentation',
    'reveal',
    'blockingIssue',
  ]);
  const blockerKeys = new Set(['kind', 'detail', 'evidence']);
  const finishStates = new Set(['ready', 'question']);
  const blockerKinds = new Set([
    'missing-information',
    'conflict',
    'not-found',
    'ambiguous',
    'incomplete',
    'unsupported',
  ]);
  const selectionKinds = new Set(['task', 'project', 'note']);
  const coverageValues = new Set(['page']);
  const presentationValues = new Set(['cumulative']);
  /** @param {unknown} value */
  const shape = (value) => {
    if (typeof value === 'string') return { type: 'string', length: value.length };
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    return { type: typeof value };
  };
  /** @param {unknown} value @param {Set<string>} known */
  const boundedKeys = (value, known) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { keys: [], unknownKeyCount: 0 };
    const keys = [];
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) keys.push(key);
      if (keys.length >= 32) break;
    }
    return {
      keys: keys.filter((key) => known.has(key)),
      unknownKeyCount: Math.min(32, keys.filter((key) => !known.has(key)).length),
    };
  };
  /** @param {unknown} value @param {Set<string>} allowed */
  const enumShape = (value, allowed) => {
    /** @type {Record<string, unknown>} */
    const result = shape(value);
    result['enum'] = typeof value === 'string' && allowed.has(value) ? value : 'other';
    return result;
  };
  /** @param {unknown} value @param {Set<string>} knownKeys */
  const referenceObjectShape = (value, knownKeys) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return shape(value);
    const properties = /** @type {Record<string, unknown>} */ (value);
    const keySummary = boundedKeys(properties, knownKeys);
    /** @type {Record<string, unknown>} */
    const summary = { keys: keySummary.keys, unknownKeyCount: keySummary.unknownKeyCount };
    for (const key of keySummary.keys) {
      summary[key] =
        key === 'kind' ? enumShape(properties[key], selectionKinds) : shape(properties[key]);
    }
    return summary;
  };
  /** @param {Record<string, unknown>} fields */
  const blockerShape = (fields) => {
    const blocking = fields['blockingIssue'];
    if (typeof blocking !== 'object' || blocking === null || Array.isArray(blocking))
      return 'blockingIssue' in fields ? shape(blocking) : undefined;
    const blocker = /** @type {Record<string, unknown>} */ (blocking);
    const blockerSummary = boundedKeys(blocker, blockerKeys);
    /** @type {Record<string, unknown>} */
    const safeBlocker = {
      keys: blockerSummary.keys,
      unknownKeyCount: blockerSummary.unknownKeyCount,
    };
    if ('kind' in blocker) safeBlocker['kind'] = enumShape(blocker['kind'], blockerKinds);
    for (const key of ['detail', 'evidence']) {
      if (key in blocker) safeBlocker[key] = shape(blocker[key]);
    }
    return safeBlocker;
  };
  /** @param {Record<string, unknown>} fields */
  const selectionShape = (fields) => {
    if (!Array.isArray(fields['selection']))
      return 'selection' in fields ? shape(fields['selection']) : undefined;
    const selections = /** @type {unknown[]} */ (fields['selection']);
    return {
      count: selections.length,
      entries: selections
        .slice(0, 5)
        .map((item) =>
          referenceObjectShape(
            item,
            new Set(['kind', 'target', 'plan', 'expectedPlanRevision', 'revision']),
          ),
        ),
    };
  };
  /** @param {unknown} value @param {string} representation */
  const summarizeFinishValue = (value, representation) => {
    /** @type {Record<string, unknown>} */
    const summary = { representation, ...boundedKeys(value, finishKeys) };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return summary;
    const fields = /** @type {Record<string, unknown>} */ (value);
    if ('state' in fields) summary['state'] = enumShape(fields['state'], finishStates);
    if ('message' in fields) summary['message'] = shape(fields['message']);
    if ('coverage' in fields) summary['coverage'] = enumShape(fields['coverage'], coverageValues);
    if ('presentation' in fields)
      summary['presentation'] = enumShape(fields['presentation'], presentationValues);
    if ('reveal' in fields)
      summary['reveal'] = referenceObjectShape(fields['reveal'], new Set(['target', 'revision']));
    const blocker = blockerShape(fields);
    if (blocker !== undefined) summary['blockingIssue'] = blocker;
    const selection = selectionShape(fields);
    if (selection !== undefined) summary['selection'] = selection;
    return summary;
  };
  /** @param {unknown} input */
  const finishInputShape = (input) => {
    if (typeof input !== 'string') {
      const representation =
        typeof input === 'object' && input !== null && !Array.isArray(input) ? 'object' : 'other';
      return summarizeFinishValue(input, representation);
    }
    if (new TextEncoder().encode(input).length > 16384)
      return { representation: 'oversized-string' };
    try {
      return summarizeFinishValue(JSON.parse(input), 'json-string');
    } catch {
      return { representation: 'invalid-json' };
    }
  };
  /** @param {unknown} content @param {Set<string>} declaredNames */
  const safeFinishInputs = (content, declaredNames) => {
    if (!Array.isArray(content) || !declaredNames.has('finish')) return [];
    const inputs = [];
    for (const part of content.slice(0, maxContentEntries)) {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('type' in part) ||
        part.type !== 'tool-call' ||
        !('toolName' in part) ||
        part.toolName !== 'finish' ||
        !('input' in part)
      )
        continue;
      inputs.push(finishInputShape(part.input));
      if (inputs.length === 8) break;
    }
    return inputs;
  };
  /** @param {unknown} params */
  const finishSchemaFingerprint = async (params) => {
    try {
      if (typeof params !== 'object' || params === null || !('tools' in params)) return undefined;
      const tools = params.tools;
      if (!Array.isArray(tools)) return undefined;
      const finish = tools
        .slice(0, 64)
        .find(
          (tool) =>
            typeof tool === 'object' &&
            tool !== null &&
            'type' in tool &&
            tool.type === 'function' &&
            'name' in tool &&
            tool.name === 'finish' &&
            'inputSchema' in tool,
        );
      if (typeof finish !== 'object' || finish === null || !('inputSchema' in finish))
        return undefined;
      const serialized = JSON.stringify(finish.inputSchema);
      if (typeof serialized !== 'string') return undefined;
      const bytes = new TextEncoder().encode(serialized);
      if (bytes.length > 65536) return undefined;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      );
    } catch {
      return undefined;
    }
  };
  /** @param {'search'|'readPage'} methodName */
  const installResearch = (methodName) => {
    const original = originals[methodName];
    /** @param {...unknown} args @this {unknown} */
    const wrapper = async function (...args) {
      if (trace.researchCalls >= 2) {
        trace.budgetRejections.push({ kind: 'research', limit: 2 });
        throw new Error('native-trace-budget-research');
      }
      trace.researchCalls++;
      const start = performance.now();
      const requested = methodName === 'readPage' ? args[0] : undefined;
      try {
        const result = await Reflect.apply(original, this, args);
        const event = successEvent(
          methodName,
          requested,
          captureUrls,
          result,
          elapsed(start),
          urlMetadata,
          addProvenance,
        );
        trace.research.push(event);
        return result;
      } catch (error) {
        trace.research.push({
          kind: methodName,
          status: 'error',
          durationMs: elapsed(start),
          errorCode: errorCode(error),
        });
        throw error;
      }
    };
    wrapped[methodName] = wrapper;
    research[methodName] = wrapper;
  };

  /** @this {unknown} */
  wrapped.model = function (...args) {
    const model = /** @type {{modelId?: unknown, doGenerate: Method}} */ (
      Reflect.apply(originals.model, this, args)
    );
    if (!model || typeof model !== 'object' || typeof model.doGenerate !== 'function') return model;
    if (model.modelId !== expectedModelId) {
      trace.guardRejections.push({ kind: 'model-id-mismatch' });
      throw new Error('native-trace-model-mismatch');
    }
    if (modelWrappers.has(model)) return model;
    const originalGenerate = model.doGenerate;
    /** @param {...unknown} generateArgs @this {unknown} */
    const instrumentedGenerate = async function (...generateArgs) {
      if (trace.sdkInvocations >= 12) {
        trace.budgetRejections.push({ kind: 'generation', limit: 12 });
        throw new Error('native-trace-budget-generation');
      }
      trace.sdkInvocations++;
      /** @type {TraceEvent} */
      const generation = {
        index: trace.sdkInvocations,
        modelId: typeof model.modelId === 'string' ? model.modelId : 'unknown',
      };
      const params = generateArgs[0];
      let declaredNames = new Set();
      let finishSchemaSha256;
      try {
        declaredNames = declaredToolNames(params);
        finishSchemaSha256 = await finishSchemaFingerprint(params);
      } catch {
        finishSchemaSha256 = undefined;
      }
      if (finishSchemaSha256 !== undefined) generation['finishSchemaSha256'] = finishSchemaSha256;
      const start = performance.now();
      try {
        const result = /** @type {Record<string, unknown>} */ (
          await Reflect.apply(originalGenerate, this, generateArgs)
        );
        generation['durationMs'] = elapsed(start);
        try {
          const finishReason = result['finishReason'];
          if (
            typeof finishReason === 'object' &&
            finishReason !== null &&
            'unified' in finishReason &&
            typeof finishReason.unified === 'string'
          )
            generation['finishReason'] = finishReasonEnums.has(finishReason.unified)
              ? finishReason.unified
              : 'other';
          const usage = safeUsage(result['usage']);
          if (usage !== undefined) generation['usage'] = usage;
          const contentSummary = contentTypeSummary(result['content']);
          generation['contentTypes'] = contentSummary.types;
          generation['contentTypeUnknownCount'] = contentSummary.unknownCount;
          generation['contentOmittedCount'] = contentSummary.omittedCount;
          generation['contentCount'] = contentSummary.count;
          const toolNameSummary = safeToolNames(result['content'], declaredNames);
          generation['toolNames'] = toolNameSummary.names;
          generation['toolNameUnknownCount'] = toolNameSummary.unknownCount;
          generation['toolNameOmittedCount'] = toolNameSummary.omittedCount;
          const finishInputs = safeFinishInputs(result['content'], declaredNames);
          if (finishInputs.length > 0) generation['finishInputs'] = finishInputs;
        } catch {
          // Diagnostic observation must never replace the provider result.
        }
        trace.generations.push(generation);
        return result;
      } catch (error) {
        generation['durationMs'] = elapsed(start);
        generation['errorCode'] = errorCode(error);
        trace.generations.push(generation);
        throw error;
      }
    };
    model.doGenerate = instrumentedGenerate;
    modelWrappers.set(model, { original: originalGenerate, wrapped: instrumentedGenerate });
    return model;
  };

  installResearch('search');
  installResearch('readPage');
  connections.model = wrapped.model;
  root[traceKey] = { trace, originals, wrapped, connections, research, modelWrappers };
  return { installed: true, preflight };
}

/** @param {'search'|'readPage'} methodName @param {unknown} requested @param {string[]} captureUrls @param {unknown} result @param {number} durationMs @param {(value: unknown) => UrlMetadata} urlMetadata @param {(event: TraceEvent, page: Record<string, unknown>, source: Record<string, unknown>, urls: string[], hashUrl: (value: unknown) => UrlMetadata) => void} addProvenance */
function researchSuccessEvent(
  methodName,
  requested,
  captureUrls,
  result,
  durationMs,
  urlMetadata,
  addProvenance,
) {
  /** @type {TraceEvent} */
  const event = { kind: methodName, status: 'ok', durationMs };
  if (methodName !== 'readPage') return event;
  if (typeof requested !== 'string' || !captureUrls.includes(requested)) {
    event.requestedUrlMetadata = urlMetadata(requested);
    return event;
  }
  event.requestedUrl = requested;
  const data =
    typeof result === 'object' && result !== null
      ? /** @type {Record<string, unknown>} */ (result)
      : {};
  const source = Array.isArray(data['sources'])
    ? data['sources'].find(
        (item) =>
          typeof item === 'object' && item !== null && 'url' in item && item.url === requested,
      )
    : undefined;
  const page =
    typeof data['page'] === 'object' && data['page'] !== null
      ? /** @type {Record<string, unknown>} */ (data['page'])
      : {};
  if (!('requestedUrl' in page) || page['requestedUrl'] !== requested || !source) return event;
  const item = /** @type {Record<string, unknown>} */ (source);
  addProvenance(event, page, item, captureUrls, urlMetadata);
  const content = typeof item['content'] === 'string' ? item['content'] : '';
  event.pageTitle = typeof item['title'] === 'string' ? item['title'].slice(0, 300) : null;
  event.content = content.slice(0, 8000);
  event.contentLength = content.length;
  event.truncated = data['truncated'] === true || content.length > 8000;
  return event;
}

/** @param {TraceEvent} event @param {Record<string, unknown>} page @param {Record<string, unknown>} item @param {string[]} captureUrls @param {(value: unknown) => UrlMetadata} urlMetadata */
function addPageProvenance(event, page, item, captureUrls, urlMetadata) {
  if (page['kind'] === 'page-content') event.pageKind = 'page-content';
  if (page['finalUrl'] === null) event.finalUrl = null;
  else if (typeof page['finalUrl'] === 'string') {
    if (captureUrls.includes(page['finalUrl'])) event.finalUrl = page['finalUrl'];
    else event.finalUrlMetadata = urlMetadata(page['finalUrl']);
  }
  if (Array.isArray(page['limitations']))
    event.limitations = page['limitations'].filter(
      (value) =>
        value === 'provider-extracted' ||
        value === 'redirect-chain-unverified' ||
        value === 'final-url-unverified' ||
        value === 'freshness-unverified',
    );
  if (typeof item['url'] === 'string' && captureUrls.includes(item['url']))
    event.sourceUrl = item['url'];
  if (
    item['evidence'] === 'citation' ||
    item['evidence'] === 'retrieved-url' ||
    item['evidence'] === 'provider-excerpt'
  )
    event.evidence = item['evidence'];
}

/** @param {unknown} requested */
function unsupportedUrlMetadata(requested) {
  const value = typeof requested === 'string' ? requested : '';
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return { hash: (hash >>> 0).toString(16).padStart(8, '0'), length: value.length };
}

/** @param {string} value */
function isHttpsUrl(value) {
  if (value.length > 2000 || value.includes('?') || value.includes('#')) return false;
  try {
    const parsed = new URL(value);
    const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/, 1)[0] ?? '';
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      !authority.includes('@')
    );
  } catch {
    return false;
  }
}

/** @param {Record<string, unknown>} root @param {string} traceKey */
function restoreNativeTrace(root, traceKey) {
  const state = /** @type {TraceState|undefined} */ (root[traceKey]);
  if (!state) return { restored: false };
  if (state.connections.model === state.wrapped.model)
    state.connections.model = state.originals.model;
  if (state.research.search === state.wrapped.search)
    state.research.search = state.originals.search;
  if (state.research.readPage === state.wrapped.readPage)
    state.research.readPage = state.originals.readPage;
  for (const [model, methods] of state.modelWrappers) {
    if (model.doGenerate === methods.wrapped) model.doGenerate = methods.original;
  }
  delete root[traceKey];
  return { restored: true };
}
