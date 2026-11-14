/** @typedef {(this: unknown, ...args: unknown[]) => unknown} Method */
/** @typedef {{kind?: string, status?: string, durationMs?: number, errorCode?: string, index?: number, modelId?: string, finishReason?: string, usage?: Record<string, number>, contentTypes?: string[], toolNames?: string[], content?: string, contentLength?: number, pageTitle?: string|null, truncated?: boolean, requestedUrl?: string, requestedUrlMetadata?: UrlMetadata, sourceUrl?: string, pageKind?: string, finalUrl?: null|string, finalUrlMetadata?: UrlMetadata, limitations?: string[], evidence?: string, sources?: unknown, page?: unknown, [key: string]: unknown}} TraceEvent */
/** @typedef {{sdkInvocations: number, researchCalls: number, generations: TraceEvent[], research: TraceEvent[], budgetRejections: TraceEvent[], guardRejections: TraceEvent[]}} Trace */
/** @typedef {{model: Method, search: Method, readPage: Method}} Methods */
/** @typedef {{providerConnections: {model: Method}, commandResearch: {search: Method, readPage: Method}}} NativePlugin */
/** @typedef {{plugins?: {plugins?: Record<string, NativePlugin>}}} NativeApp */
/** @typedef {{hash: string, length: number}} UrlMetadata */
/** @typedef {{nodes: number, seen: WeakSet<object>, truncated: boolean}} ReadContext */
/** @typedef {{inputs: Record<string, unknown>[], omittedCount: number, truncated: boolean, failureCount: number, registrationOmittedCount: number, registrationTruncated: boolean}} ReadInputObservation */
/** @typedef {{results: Record<string, unknown>[], omittedCount: number, truncated: boolean, failureCount: number, unattributedCount: number, visited: number}} IncomingObservation */
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
  const maxToolCallIds = 128;
  const maxReadInputShapes = 8;
  const maxReadShapeDepth = 6;
  const maxReadShapeNodes = 64;
  const maxReadObjectKeys = 32;
  const toolCallsById = new Map();
  const observedToolResults = new Set();
  const readToolNames = new Set(['find', 'inspect', 'read']);
  const commandInputToolNames = new Set(['find', 'interpret', 'assess_research']);
  const resultToolNames = new Set([...readToolNames, 'finish']);
  const readKeys = new Set([
    'kind',
    'read',
    'input',
    'query',
    'cursor',
    'path',
    'folder',
    'inbox',
    'statuses',
    'tagsAll',
    'dates',
    'field',
    'from',
    'to',
    'fields',
    'matchScope',
    'target',
    'expectedRevision',
    'side',
    'plan',
    'expectedPlanRevision',
    'limit',
    'prefix',
    'selector',
    'linkFor',
    'limitCharacters',
    'link',
    'section',
    'wikiLink',
    'expectedFromRevision',
    'alias',
  ]);
  /** @type {Record<string, Set<string>>} */
  const readEnums = {
    kind: new Set([
      'tasks',
      'tree',
      'tags',
      'statuses',
      'projects',
      'project',
      'project-schema',
      'notes',
      'note',
    ]),
    side: new Set(['before', 'after']),
    fields: new Set(['title', 'body', 'all', 'name']),
    matchScope: new Set(['node', 'subtree']),
    field: new Set(['created', 'start', 'scheduled', 'due', 'completion', 'cancelled']),
    status: new Set(['open', 'in-progress', 'done', 'cancelled']),
  };
  const diagnosticCodes = new Set([
    'INVALID_ARGUMENT',
    'INVALID_ARGUMENTS',
    'INVALID_INPUT',
    'VALIDATION_ERROR',
  ]);
  const diagnosticPathSegments = new Set([...readKeys, 'selection', 'states', 'status']);
  const finishDiagnosticCodes = new Set([
    ...diagnosticCodes,
    'PENDING_TASK_CHANGE',
    'UNGROUNDED_FINISH',
    'UNGROUNDED_QUESTION',
    'UNRESOLVED',
    'STALE',
    'TIMEOUT',
    'CANCELLED',
    'ABORTED',
  ]);
  const finishDiagnosticPathSegments = new Set([
    'finish',
    'input',
    'selection',
    'kind',
    'target',
    'plan',
    'expectedPlanRevision',
    'revision',
    'state',
    'message',
    'coverage',
    'presentation',
    'reveal',
    'blockingIssue',
    'detail',
    'evidence',
  ]);
  const toolResultOutputTypes = new Set([
    'text',
    'json',
    'execution-denied',
    'error-text',
    'error-json',
    'content',
  ]);
  const referenceInputKeys = new Set([
    'target',
    'cursor',
    'expectedRevision',
    'plan',
    'expectedPlanRevision',
    'expectedFromRevision',
    'section',
    'from',
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
  /** @param {object} part @param {number} generationOrdinal @param {number} callOrdinal @param {{inputs: Record<string, unknown>[], omittedCount: number, failureCount: number, registrationOmittedCount: number, truncated: boolean}} result */
  const captureFinishToolCallInput = (part, generationOrdinal, callOrdinal, result) => {
    if (!tryRegisterReadToolCall(part, generationOrdinal, callOrdinal)) {
      result.registrationOmittedCount++;
      result.truncated = true;
    }
    if (result.inputs.length >= maxReadInputShapes) {
      result.omittedCount++;
      result.truncated = true;
      return;
    }
    try {
      if (!('input' in part)) {
        result.inputs.push({ representation: 'missing', inputParseFailed: true });
        result.failureCount++;
        return;
      }
      result.inputs.push(finishInputShape(part.input));
    } catch {
      result.failureCount = Math.min(1_000_000, result.failureCount + 1);
      result.omittedCount = Math.min(1_000_000, result.omittedCount + 1);
      result.truncated = true;
    }
  };
  /** @param {unknown} content @param {Set<string>} declaredNames @param {number} generationOrdinal */
  const safeFinishInputs = (content, declaredNames, generationOrdinal) => {
    const result =
      /** @type {{inputs: Record<string, unknown>[], omittedCount: number, failureCount: number, registrationOmittedCount: number, truncated: boolean}} */ ({
        inputs: [],
        omittedCount: 0,
        failureCount: 0,
        registrationOmittedCount: 0,
        truncated: false,
      });
    if (!Array.isArray(content)) {
      result.failureCount = 1;
      result.truncated = true;
      return result;
    }
    if (!declaredNames.has('finish')) return result;
    let callOrdinal = 0;
    for (const part of content.slice(0, maxContentEntries)) {
      try {
        if (
          typeof part !== 'object' ||
          part === null ||
          !('type' in part) ||
          part.type !== 'tool-call'
        )
          continue;
        callOrdinal++;
        if (!('toolName' in part) || part.toolName !== 'finish') continue;
        captureFinishToolCallInput(part, generationOrdinal, callOrdinal, result);
      } catch {
        result.failureCount = Math.min(1_000_000, result.failureCount + 1);
        result.omittedCount = Math.min(1_000_000, result.omittedCount + 1);
        result.truncated = true;
      }
    }
    if (content.length > maxContentEntries) {
      result.omittedCount = Math.min(
        1_000_000,
        result.omittedCount + content.length - maxContentEntries,
      );
      result.truncated = true;
    }
    return result;
  };
  /** @param {Record<string, unknown>} generation @param {unknown} content @param {Set<string>} declaredNames @param {number} generationOrdinal */
  const recordFinishInputObservation = (generation, content, declaredNames, generationOrdinal) => {
    const observation = safeFinishInputs(content, declaredNames, generationOrdinal);
    if (observation.inputs.length > 0) generation['finishInputs'] = observation.inputs;
    if (
      observation.omittedCount > 0 ||
      observation.failureCount > 0 ||
      observation.registrationOmittedCount > 0 ||
      observation.truncated
    ) {
      generation['finishInputOmittedCount'] = observation.omittedCount;
      generation['finishInputFailureCount'] = observation.failureCount;
      generation['finishCallRegistrationOmittedCount'] = observation.registrationOmittedCount;
      generation['finishInputsTruncated'] = observation.truncated;
    }
  };
  /** @param {unknown} input @returns {Record<string, unknown>} */
  const parseReadInput = (input) => {
    if (typeof input !== 'string')
      return { value: input, representation: shape(input).type === 'object' ? 'object' : 'other' };
    if (input.length > 16384)
      return { summary: { representation: 'oversized-string', inputTruncated: true } };
    if (new TextEncoder().encode(input).length > 16384)
      return { summary: { representation: 'oversized-string', inputTruncated: true } };
    try {
      return { value: JSON.parse(input), representation: 'json-string' };
    } catch {
      return { summary: { representation: 'invalid-json', inputParseFailed: true } };
    }
  };
  /** @param {unknown} value @returns {Record<string, unknown>} */
  const boundedObservationShape = (value) => {
    const summary = shape(value);
    if (summary['type'] === 'string') {
      const length = /** @type {number} */ (summary['length']);
      return { type: 'string', length: Math.min(10000, length), lengthTruncated: length > 10000 };
    }
    if (summary['type'] === 'array') {
      const length = /** @type {number} */ (summary['length']);
      return { type: 'array', length: Math.min(10000, length), lengthTruncated: length > 10000 };
    }
    return summary;
  };
  /** @param {Record<string, unknown>} fields @param {string} key @param {Set<string>} allowed @returns {Record<string, unknown>} */
  const observedEnumField = (fields, key, allowed) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return { status: 'omitted' };
    const value = fields[key];
    return typeof value === 'string' && allowed.has(value)
      ? { status: 'allowed', value }
      : { status: 'invalid', shape: boundedObservationShape(value) };
  };
  /** @param {Record<string, unknown>} fields @param {string} key @returns {Record<string, unknown>} */
  const observedBooleanField = (fields, key) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return { status: 'omitted' };
    const value = fields[key];
    return typeof value === 'boolean'
      ? { status: 'valid', value }
      : { status: 'invalid', shape: boundedObservationShape(value) };
  };
  /** @param {Record<string, unknown>} fields @param {string} key @param {boolean} [unknownIssuance] @returns {Record<string, unknown>} */
  const observedShapeField = (fields, key, unknownIssuance = false) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key))
      return { status: 'omitted', ...(unknownIssuance ? { issued: 'unknown' } : {}) };
    const value = fields[key];
    return {
      status: typeof value === 'string' ? 'present' : 'invalid',
      shape: boundedObservationShape(value),
      ...(unknownIssuance ? { issued: 'unknown' } : {}),
    };
  };
  /** @param {string} sourceName @param {unknown} input @returns {Record<string, unknown>} */
  const commandInputShape = (sourceName, input) => {
    const parsed = parseReadInput(input);
    if (typeof parsed['summary'] === 'object' && parsed['summary'] !== null) {
      const summary = /** @type {Record<string, unknown>} */ (parsed['summary']);
      return { representation: summary['representation'], fieldsUnavailable: true };
    }
    const value = parsed['value'];
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { representation: parsed['representation'], fieldsUnavailable: true };
    const fields = /** @type {Record<string, unknown>} */ (value);
    const result = /** @type {Record<string, unknown>} */ ({
      representation: parsed['representation'],
    });
    if (sourceName === 'find') {
      result['purpose'] = observedEnumField(
        fields,
        'purpose',
        new Set(['change', 'remove', 'show-only', 'locate-child']),
      );
      result['showExact'] = observedBooleanField(fields, 'showExact');
      result['taskId'] = observedShapeField(fields, 'taskId');
      result['retryOf'] = observedShapeField(fields, 'retryOf', true);
    } else if (sourceName === 'interpret') {
      result['intent'] = observedEnumField(
        fields,
        'intent',
        new Set([
          'plan',
          'confirm',
          'immediate',
          'save-then-plan',
          'review',
          'new-session',
          'acknowledge-uncertainty',
          'voice-mode',
          'resolve-transition',
        ]),
      );
    } else if (sourceName === 'assess_research') {
      result['allowed'] = observedBooleanField(fields, 'allowed');
      result['requiresTaskPreparation'] = observedBooleanField(fields, 'requiresTaskPreparation');
    }
    return result;
  };
  /** @param {unknown} content @param {Set<string>} declaredNames @param {number} generationOrdinal */
  const safeCommandInputs = (content, declaredNames, generationOrdinal) => {
    const result =
      /** @type {{inputs: Record<string, unknown>[], omittedCount: number, failureCount: number, truncated: boolean}} */ ({
        inputs: [],
        omittedCount: 0,
        failureCount: 0,
        truncated: false,
      });
    if (!Array.isArray(content)) {
      result.failureCount = 1;
      result.truncated = true;
      return result;
    }
    let callOrdinal = 0;
    for (const part of content.slice(0, maxContentEntries)) {
      try {
        if (
          typeof part !== 'object' ||
          part === null ||
          !('type' in part) ||
          part.type !== 'tool-call'
        )
          continue;
        callOrdinal++;
        const record = /** @type {Record<string, unknown>} */ (part);
        const sourceName = record['toolName'];
        if (
          typeof sourceName !== 'string' ||
          !commandInputToolNames.has(sourceName) ||
          !declaredNames.has(sourceName)
        )
          continue;
        if (result.inputs.length >= maxReadInputShapes) {
          result.omittedCount++;
          result.truncated = true;
          continue;
        }
        const observation = {
          sourceName,
          generationOrdinal,
          callOrdinal,
          ...commandInputShape(sourceName, 'input' in record ? record['input'] : undefined),
        };
        if (!tryRegisterReadToolCall(part, generationOrdinal, callOrdinal)) result.omittedCount++;
        result.inputs.push(observation);
      } catch {
        result.failureCount++;
        result.omittedCount++;
        result.truncated = true;
      }
    }
    if (content.length > maxContentEntries) {
      result.omittedCount += Math.min(1_000_000, content.length - maxContentEntries);
      result.truncated = true;
    }
    return result;
  };
  /** @param {Record<string, unknown>} value */
  const boundedReadKeys = (value) => {
    const keys = [];
    let unknownKeyCount = 0;
    let visited = 0;
    let truncated = false;
    for (const key in value) {
      visited++;
      if (visited > maxReadObjectKeys) {
        truncated = true;
        break;
      }
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (readKeys.has(key)) keys.push(key);
      else unknownKeyCount++;
    }
    return {
      keys,
      unknownKeyCount,
      ...(truncated ? { keyScanTruncated: true, omittedKeyCountAtLeast: 1 } : {}),
    };
  };
  /** @param {unknown} value @param {ReadContext} context @param {string} reason */
  const omittedReadShape = (value, context, reason) => {
    context.truncated = true;
    return { ...shape(value), omitted: true, omissionReason: reason };
  };
  /** @param {unknown} value */
  const boundedReadValueShape = (value) => {
    /** @type {Record<string, unknown>} */
    const summary = shape(value);
    const lengthCap = 1_000_000;
    if (
      summary['type'] === 'string' &&
      typeof summary['length'] === 'number' &&
      summary['length'] > lengthCap
    ) {
      summary['length'] = lengthCap;
      summary['lengthTruncated'] = true;
    }
    if (
      summary['type'] === 'array' &&
      typeof summary['length'] === 'number' &&
      summary['length'] > lengthCap
    ) {
      summary['length'] = lengthCap;
      summary['lengthTruncated'] = true;
    }
    return summary;
  };
  /** @param {unknown[]} item @param {number} depth @param {ReadContext} context */
  const datesShape = (item, depth, context) => {
    if (context.seen.has(item)) return omittedReadShape(item, context, 'repeated-reference');
    context.seen.add(item);
    return {
      type: 'array',
      count: Math.min(1000, item.length),
      countTruncated: item.length > 1000,
      entries: item.slice(0, 6).map((entry) => readObjectShape(entry, depth + 1, context)),
      omittedCount: Math.min(1000, Math.max(0, item.length - 6)),
    };
  };
  /** @param {string} key @param {unknown} item @param {number} depth @param {ReadContext} context */
  const nestedReadShape = (key, item, depth, context) => {
    if (key === 'dates' && Array.isArray(item)) return datesShape(item, depth, context);
    if ((key === 'input' || key === 'read') && typeof item === 'string') {
      const parsed = parseReadInput(item);
      if (typeof parsed['summary'] === 'object' && parsed['summary'] !== null) {
        context.truncated = true;
        return /** @type {Record<string, unknown>} */ (parsed['summary']);
      }
      return {
        representation: parsed['representation'],
        ...readObjectShape(parsed['value'], depth + 1, context),
      };
    }
    if (
      ['input', 'read', 'selector', 'linkFor', 'link'].includes(key) &&
      typeof item === 'object' &&
      item !== null
    )
      return readObjectShape(item, depth + 1, context);
    return undefined;
  };
  /** @param {string} key @param {unknown} item @param {number} depth @param {ReadContext} context */
  const readFieldShape = (key, item, depth, context) => {
    if (key === 'inbox')
      return typeof item === 'boolean'
        ? { type: 'boolean', value: item }
        : boundedReadValueShape(item);
    if (key === 'limit' || key === 'limitCharacters')
      return typeof item === 'number' && Number.isFinite(item)
        ? { type: 'number', value: Math.max(-100000, Math.min(100000, item)) }
        : boundedReadValueShape(item);
    if (readEnums[key]) return enumShape(item, readEnums[key]);
    const statusValues = readEnums['status'];
    if (key === 'statuses' && Array.isArray(item) && statusValues)
      return {
        type: 'array',
        count: Math.min(1000, item.length),
        countTruncated: item.length > 1000,
        entries: item.slice(0, 8).map((entry) => enumShape(entry, statusValues)),
        omittedCount: Math.min(1000, Math.max(0, item.length - 8)),
      };
    const nested = nestedReadShape(key, item, depth, context);
    if (nested !== undefined) return nested;
    /** @type {Record<string, unknown>} */
    const summary = boundedReadValueShape(item);
    if (referenceInputKeys.has(key)) summary['issued'] = 'unknown';
    return summary;
  };
  /** @param {unknown} value @param {number} depth @param {ReadContext} context */
  const readObjectShape = (value, depth, context) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return shape(value);
    if (depth >= maxReadShapeDepth) return omittedReadShape(value, context, 'depth-limit');
    if (context.seen.has(value)) return omittedReadShape(value, context, 'repeated-reference');
    if (context.nodes >= maxReadShapeNodes) return omittedReadShape(value, context, 'node-limit');
    context.nodes++;
    context.seen.add(value);
    const source = /** @type {Record<string, unknown>} */ (value);
    const keySummary = boundedReadKeys(source);
    if (keySummary['keyScanTruncated']) context.truncated = true;
    /** @type {Record<string, unknown>} */
    const summary = { ...keySummary };
    for (let index = 0; index < keySummary.keys.length; index++) {
      if (context.nodes >= maxReadShapeNodes) {
        summary['omittedFieldCount'] = keySummary.keys.length - index;
        summary['shapeOmitted'] = true;
        context.truncated = true;
        break;
      }
      const key = keySummary.keys[index];
      if (key === undefined) continue;
      context.nodes++;
      summary[key] = readFieldShape(key, source[key], depth, context);
    }
    return summary;
  };
  /** @param {unknown} part @param {number} generationOrdinal @param {number} callOrdinal */
  const registerReadToolCall = (part, generationOrdinal, callOrdinal) => {
    const record = /** @type {Record<string, unknown>} */ (part);
    const callId = record['toolCallId'];
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256) return false;
    if (toolCallsById.has(callId)) {
      const previous = toolCallsById.get(callId);
      return (
        previous.sourceName === record['toolName'] &&
        previous.generationOrdinal === generationOrdinal &&
        previous.callOrdinal === callOrdinal
      );
    }
    if (toolCallsById.size >= maxToolCallIds) return false;
    toolCallsById.set(callId, {
      sourceName: record['toolName'],
      generationOrdinal,
      callOrdinal,
    });
    return true;
  };
  /** @param {unknown} part @param {number} generationOrdinal @param {number} callOrdinal */
  const tryRegisterReadToolCall = (part, generationOrdinal, callOrdinal) => {
    try {
      return registerReadToolCall(part, generationOrdinal, callOrdinal);
    } catch {
      return false;
    }
  };
  /** @param {unknown} part */
  const readInputCallShape = (part) => {
    const record = /** @type {Record<string, unknown>} */ (part);
    if (!('input' in record))
      return {
        summary: { representation: 'missing', inputParseFailed: true },
        failure: true,
        truncated: false,
      };
    const parsed = parseReadInput(record['input']);
    if (typeof parsed['summary'] === 'object' && parsed['summary'] !== null) {
      const summary = /** @type {Record<string, unknown>} */ (parsed['summary']);
      return {
        summary,
        failure: summary['inputParseFailed'] === true,
        truncated: summary['inputTruncated'] === true,
      };
    }
    /** @type {ReadContext} */
    const walk = { nodes: 0, seen: new WeakSet(), truncated: false };
    return {
      summary: {
        representation: parsed['representation'],
        ...readObjectShape(parsed['value'], 0, walk),
        ...(walk.truncated ? { shapeTruncated: true } : {}),
      },
      failure: false,
      truncated: walk.truncated,
    };
  };
  /** @param {unknown} part @param {Set<string>} declaredNames @param {number} callOrdinal */
  const declaredReadToolCall = (part, declaredNames, callOrdinal) => {
    if (typeof part !== 'object' || part === null || !('type' in part) || part.type !== 'tool-call')
      return undefined;
    const record = /** @type {Record<string, unknown>} */ (part);
    const sourceName = record['toolName'];
    if (
      typeof sourceName !== 'string' ||
      !readToolNames.has(sourceName) ||
      !declaredNames.has(sourceName)
    )
      return undefined;
    return { sourceName, callOrdinal };
  };
  /** @param {unknown} part @param {{sourceName: string, callOrdinal: number}} declaredCall @param {ReadInputObservation} result @param {number} generationOrdinal @param {number} shapedReads */
  const captureDeclaredReadCall = (part, declaredCall, result, generationOrdinal, shapedReads) => {
    if (!tryRegisterReadToolCall(part, generationOrdinal, declaredCall.callOrdinal))
      result.registrationOmittedCount++;
    if (shapedReads >= maxReadInputShapes) {
      result.omittedCount++;
      result.truncated = true;
      return false;
    }
    const observation = readInputCallShape(part);
    result.inputs.push({
      sourceName: declaredCall.sourceName,
      generationOrdinal,
      callOrdinal: declaredCall.callOrdinal,
      ...observation.summary,
    });
    if (observation.failure) result.failureCount++;
    if (observation.truncated) result.truncated = true;
    return true;
  };
  /** @param {unknown[]} content @param {Set<string>} declaredNames @param {number} generationOrdinal @param {ReadInputObservation} result */
  const inspectReadContent = (content, declaredNames, generationOrdinal, result) => {
    let callOrdinal = 0;
    let shapedReads = 0;
    for (const part of content.slice(0, maxContentEntries)) {
      try {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'tool-call'
        )
          callOrdinal++;
        const declaredCall = declaredReadToolCall(part, declaredNames, callOrdinal);
        if (!declaredCall) continue;
        if (captureDeclaredReadCall(part, declaredCall, result, generationOrdinal, shapedReads))
          shapedReads++;
      } catch {
        result.failureCount++;
        result.truncated = true;
        result.omittedCount++;
      }
    }
  };
  /** @param {unknown} content @param {Set<string>} declaredNames @param {number} generationOrdinal */
  const safeReadInputs = (content, declaredNames, generationOrdinal) => {
    /** @type {ReadInputObservation} */
    const result = {
      inputs: [],
      omittedCount: 0,
      truncated: false,
      failureCount: 0,
      registrationOmittedCount: 0,
      registrationTruncated: false,
    };
    if (!Array.isArray(content)) {
      result.failureCount = 1;
      result.truncated = true;
      return result;
    }
    if (content.length > maxContentEntries) {
      result.truncated = true;
      result.registrationTruncated = true;
      result.omittedCount = Math.min(1_000_000, content.length - maxContentEntries);
    }
    inspectReadContent(content, declaredNames, generationOrdinal, result);
    return result;
  };
  /** @param {unknown} candidate */
  const safeValidationPath = (candidate, allowedSegments = diagnosticPathSegments) => {
    if (!Array.isArray(candidate)) return undefined;
    const path = /** @type {unknown[]} */ (candidate);
    return {
      segments: path.slice(0, 12).map((segment) => safePathSegment(segment, allowedSegments)),
      truncated: path.length > 12,
      omittedCount: Math.min(1_000_000, Math.max(0, path.length - 12)),
      omittedCountTruncated: path.length - 12 > 1_000_000,
    };
  };
  /** @param {unknown} output */
  const isToolResultOutput = (output) => {
    if (typeof output !== 'object' || output === null || !('type' in output)) return false;
    const record = /** @type {Record<string, unknown>} */ (output);
    if (typeof record['type'] !== 'string' || !toolResultOutputTypes.has(record['type']))
      return false;
    if (record['type'] === 'text' || record['type'] === 'error-text')
      return typeof record['value'] === 'string';
    if (record['type'] === 'json' || record['type'] === 'error-json') return 'value' in record;
    if (record['type'] === 'content') return Array.isArray(record['value']);
    return record['reason'] === undefined || typeof record['reason'] === 'string';
  };
  /** @param {unknown} output @param {string} [sourceName] @returns {Record<string, unknown>} */
  const safeToolResultDiagnostic = (output, sourceName) => {
    const record = /** @type {Record<string, unknown>} */ (output);
    const isError = record['type'] === 'error-text' || record['type'] === 'error-json';
    const errorText = record['type'] === 'error-text' ? record['value'] : undefined;
    const value = record['type'] === 'error-json' ? record['value'] : undefined;
    const structured =
      typeof value === 'object' && value !== null
        ? /** @type {Record<string, unknown>} */ (value)
        : {};
    const allowedCodes = sourceName === 'finish' ? finishDiagnosticCodes : diagnosticCodes;
    const code =
      typeof structured['code'] === 'string' && allowedCodes.has(structured['code'])
        ? structured['code']
        : undefined;
    const hasPath = 'validationPath' in structured || 'path' in structured;
    const allowedPathSegments =
      sourceName === 'finish' ? finishDiagnosticPathSegments : diagnosticPathSegments;
    const validationPath = safeValidationPath(
      structured['validationPath'] ?? structured['path'],
      allowedPathSegments,
    );
    return {
      resultKind: isError ? 'error' : 'result',
      ...(errorText === 'Invalid API argument.'
        ? { errorClassification: 'invalid-api-argument' }
        : {}),
      ...(code ? { code } : {}),
      ...(validationPath
        ? {
            validationPath: validationPath.segments,
            validationPathTruncated: validationPath.truncated,
            validationPathOmittedCount: validationPath.omittedCount,
            validationPathOmittedCountTruncated: validationPath.omittedCountTruncated,
          }
        : {}),
      ...(hasPath && !validationPath ? { validationPathMalformed: true } : {}),
      codeUnavailable: code === undefined,
      validationUnavailable: validationPath === undefined,
    };
  };
  /** @param {unknown} output */
  const safeFinishResultDiagnostic = (output) => {
    const record = /** @type {Record<string, unknown>} */ (output);
    const type = record['type'];
    if (type === 'error-text' || type === 'error-json')
      return { ...safeToolResultDiagnostic(output, 'finish'), finishOutcome: 'rejected' };
    if (type === 'execution-denied')
      return { resultKind: 'error', finishOutcome: 'rejected', codeUnavailable: true };
    if (type !== 'json' || typeof record['value'] !== 'object' || record['value'] === null)
      return {
        resultKind: 'unknown',
        finishOutcome: 'unknown',
        codeUnavailable: true,
        validationUnavailable: true,
      };
    const value = /** @type {Record<string, unknown>} */ (record['value']);
    let finishOutcome = 'unknown';
    if (value['finished'] === true) finishOutcome = 'accepted';
    else if (value['finished'] === false) finishOutcome = 'unfinished';
    else if (value['needsDisposition'] === true) finishOutcome = 'needs-disposition';
    return { resultKind: 'result', finishOutcome, codeUnavailable: true };
  };
  /** @param {string} sourceName @param {Record<string, unknown>} diagnostic */
  const isDeduplicableToolResult = (sourceName, diagnostic) =>
    sourceName !== 'finish' || diagnostic['finishOutcome'] !== 'unknown';
  /** @param {string} sourceName @param {unknown} output @returns {{diagnostic?: Record<string, unknown>, deduplicate: boolean, omitted?: string}} */
  const observeAttributedToolResult = (sourceName, output) => {
    if (!isToolResultOutput(output)) {
      if (sourceName !== 'finish') return { omitted: 'invalid-envelope', deduplicate: false };
      return {
        diagnostic: {
          resultKind: 'unknown',
          finishOutcome: 'unknown',
          resultUnavailable: true,
          codeUnavailable: true,
          validationUnavailable: true,
        },
        deduplicate: false,
      };
    }
    const diagnostic =
      sourceName === 'finish'
        ? safeFinishResultDiagnostic(output)
        : safeToolResultDiagnostic(output, sourceName);
    return { diagnostic, deduplicate: isDeduplicableToolResult(sourceName, diagnostic) };
  };
  /** @param {unknown} segment @param {Set<string>} allowed */
  const safePathSegment = (segment, allowed) => {
    if (
      typeof segment === 'number' &&
      Number.isInteger(segment) &&
      segment >= 0 &&
      segment <= 100000
    )
      return { index: segment };
    return {
      key: typeof segment === 'string' && allowed.has(segment) ? segment : 'unknown',
    };
  };
  /** @param {unknown} part @param {Set<string>} declaredNames @returns {{summary?: Record<string, unknown>, omitted?: string, duplicate?: boolean}} */
  const incomingToolResultPart = (part, declaredNames) => {
    if (
      typeof part !== 'object' ||
      part === null ||
      !('type' in part) ||
      part.type !== 'tool-result' ||
      !('toolCallId' in part) ||
      typeof part.toolCallId !== 'string'
    )
      return {};
    const callId = part.toolCallId;
    const record = /** @type {Record<string, unknown>} */ (part);
    if (callId.length === 0 || callId.length > 256) return { omitted: 'invalid-envelope' };
    if (observedToolResults.has(callId)) return { duplicate: true };
    if (observedToolResults.size >= maxToolCallIds) return { omitted: 'dedup-cap' };
    const attribution = toolCallsById.get(callId);
    const partName = record['toolName'];
    if (typeof partName !== 'string') return { omitted: 'invalid-envelope' };
    if (!attribution)
      return resultToolNames.has(partName) && declaredNames.has(partName)
        ? { omitted: 'unattributed' }
        : {};
    if (partName !== attribution.sourceName) return { omitted: 'source-mismatch' };
    if (!resultToolNames.has(attribution.sourceName)) return {};
    const observedResult = observeAttributedToolResult(attribution.sourceName, record['output']);
    if (observedResult.omitted) return { omitted: observedResult.omitted };
    const diagnostic = observedResult.diagnostic ?? {};
    const summary = {
      sourceName: attribution.sourceName,
      generationOrdinal: attribution.generationOrdinal,
      callOrdinal: attribution.callOrdinal,
      ...diagnostic,
    };
    if (observedResult.deduplicate) observedToolResults.add(callId);
    return { summary };
  };
  /** @param {unknown} message */
  const promptMessageParts = (message) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('content' in message) ||
      !Array.isArray(message.content)
    )
      return { parts: [], omittedCount: 0 };
    return {
      parts: message.content.slice(0, maxContentEntries),
      omittedCount: Math.min(1_000_000, Math.max(0, message.content.length - maxContentEntries)),
    };
  };
  /** @param {IncomingObservation} observation @param {string} [kind] */
  const omitIncomingResult = (observation, kind) => {
    observation.omittedCount = Math.min(1_000_000, observation.omittedCount + 1);
    observation.truncated = true;
    if (kind === 'failure') observation.failureCount++;
    if (kind === 'unattributed') observation.unattributedCount++;
  };
  /** @param {unknown} part @param {Set<string>} declaredNames @param {IncomingObservation} observation */
  const appendIncomingResult = (part, declaredNames, observation) => {
    if (observation.results.length >= maxRecordedEntries) {
      omitIncomingResult(observation);
      return false;
    }
    try {
      const result = incomingToolResultPart(part, declaredNames);
      if (result.summary) observation.results.push(result.summary);
      else if (result.omitted === 'invalid-envelope' || result.omitted === 'source-mismatch')
        omitIncomingResult(observation, 'failure');
      else if (result.omitted === 'unattributed') omitIncomingResult(observation, 'unattributed');
      else if (result.omitted) omitIncomingResult(observation);
      return true;
    } catch {
      omitIncomingResult(observation, 'failure');
      return true;
    }
  };
  /** @param {unknown} message @param {Set<string>} declaredNames @param {IncomingObservation} observation */
  const appendIncomingMessage = (message, declaredNames, observation) => {
    if (typeof message !== 'object' || message === null) return true;
    try {
      if (!('role' in message) || message.role !== 'tool') return true;
    } catch {
      omitIncomingResult(observation, 'failure');
      return true;
    }
    let messageParts;
    try {
      messageParts = promptMessageParts(message);
    } catch {
      omitIncomingResult(observation, 'failure');
      return true;
    }
    if (messageParts.omittedCount > 0) {
      observation.omittedCount = Math.min(
        1_000_000,
        observation.omittedCount + messageParts.omittedCount,
      );
      observation.truncated = true;
    }
    for (const part of messageParts.parts) {
      if (observation.visited >= maxContentEntries) {
        omitIncomingResult(observation);
        return false;
      }
      observation.visited++;
      if (!appendIncomingResult(part, declaredNames, observation)) return false;
    }
    return true;
  };
  /** @param {unknown} prompt @param {Set<string>} declaredNames */
  const safeIncomingToolResults = (prompt, declaredNames) => {
    if (!Array.isArray(prompt))
      return {
        results: [],
        omittedCount: 0,
        truncated: false,
        failureCount: 1,
        unattributedCount: 0,
        visited: 0,
      };
    /** @type {IncomingObservation} */
    const observation = {
      results: [],
      omittedCount: Math.min(1_000_000, Math.max(0, prompt.length - maxContentEntries)),
      truncated: prompt.length > maxContentEntries,
      failureCount: 0,
      unattributedCount: 0,
      visited: 0,
    };
    for (const message of prompt.slice(0, maxContentEntries)) {
      if (!appendIncomingMessage(message, declaredNames, observation)) break;
    }
    return observation;
  };
  /** @param {unknown} params @returns {Promise<{declaredNames: Set<string>, finishSchemaSha256: string|undefined, toolResults: Record<string, unknown>[], toolResultsOmittedCount: number, toolResultsTruncated: boolean, toolResultsFailureCount: number, toolResultsUnattributedCount: number}>} */
  const observeGenerationInputs = async (params) => {
    /** @type {Set<string>} */
    let declaredNames = new Set();
    let finishSchemaSha256;
    /** @type {Record<string, unknown>[]} */
    let toolResults = [];
    let toolResultsOmittedCount = 0;
    let toolResultsTruncated = false;
    let toolResultsFailureCount = 0;
    let toolResultsUnattributedCount = 0;
    try {
      declaredNames = declaredToolNames(params);
      finishSchemaSha256 = await finishSchemaFingerprint(params);
      const prompt =
        typeof params === 'object' && params !== null && 'prompt' in params
          ? /** @type {Record<string, unknown>} */ (params)['prompt']
          : undefined;
      const observation = safeIncomingToolResults(prompt, declaredNames);
      toolResults = observation.results;
      toolResultsOmittedCount = observation.omittedCount;
      toolResultsTruncated = observation.truncated;
      toolResultsFailureCount = observation.failureCount;
      toolResultsUnattributedCount = observation.unattributedCount;
    } catch {
      toolResultsFailureCount++;
      toolResultsOmittedCount = Math.max(1, toolResultsOmittedCount);
      toolResultsTruncated = true;
    }
    return {
      declaredNames,
      finishSchemaSha256,
      toolResults,
      toolResultsOmittedCount,
      toolResultsTruncated,
      toolResultsFailureCount,
      toolResultsUnattributedCount,
    };
  };
  /** @param {TraceEvent} generation @param {Awaited<ReturnType<typeof observeGenerationInputs>>} observation */
  const addInputObservations = (generation, observation) => {
    if (observation.finishSchemaSha256 !== undefined)
      generation['finishSchemaSha256'] = observation.finishSchemaSha256;
    if (observation.toolResults.length > 0) generation['toolResults'] = observation.toolResults;
    const hasToolResultGaps =
      observation.toolResultsOmittedCount > 0 ||
      observation.toolResultsTruncated ||
      observation.toolResultsFailureCount > 0 ||
      observation.toolResultsUnattributedCount > 0;
    if (hasToolResultGaps) {
      generation['toolResultsOmittedCount'] = observation.toolResultsOmittedCount;
      generation['toolResultsTruncated'] = observation.toolResultsTruncated;
      generation['toolResultsFailureCount'] = observation.toolResultsFailureCount;
      generation['toolResultsUnattributedCount'] = observation.toolResultsUnattributedCount;
    }
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
      const generationIndex = trace.sdkInvocations;
      /** @type {TraceEvent} */
      const generation = {
        index: generationIndex,
        modelId: typeof model.modelId === 'string' ? model.modelId : 'unknown',
      };
      const params = generateArgs[0];
      const inputObservation = await observeGenerationInputs(params);
      const declaredNames = inputObservation.declaredNames;
      addInputObservations(generation, inputObservation);
      const start = performance.now();
      try {
        const result = /** @type {Record<string, unknown>} */ (
          await Reflect.apply(originalGenerate, this, generateArgs)
        );
        generation['durationMs'] = elapsed(start);
        try {
          const readInputObservation = safeReadInputs(
            result['content'],
            declaredNames,
            generationIndex,
          );
          if (readInputObservation.inputs.length > 0)
            generation['readInputs'] = readInputObservation.inputs;
          if (
            readInputObservation.omittedCount > 0 ||
            readInputObservation.truncated ||
            readInputObservation.failureCount > 0 ||
            readInputObservation.registrationOmittedCount > 0 ||
            readInputObservation.registrationTruncated
          ) {
            generation['readInputOmittedCount'] = readInputObservation.omittedCount;
            generation['readInputsTruncated'] = readInputObservation.truncated;
            generation['readInputFailureCount'] = readInputObservation.failureCount;
            generation['readCallRegistrationOmittedCount'] =
              readInputObservation.registrationOmittedCount;
            generation['readCallRegistrationTruncated'] =
              readInputObservation.registrationTruncated;
          }
        } catch {
          generation['readInputFailureCount'] = 1;
          generation['readInputsTruncated'] = true;
        }
        try {
          const commandInputObservation = safeCommandInputs(
            result['content'],
            declaredNames,
            generationIndex,
          );
          if (commandInputObservation.inputs.length > 0)
            generation['commandInputs'] = commandInputObservation.inputs;
          if (
            commandInputObservation.omittedCount > 0 ||
            commandInputObservation.failureCount > 0 ||
            commandInputObservation.truncated
          ) {
            generation['commandInputOmittedCount'] = commandInputObservation.omittedCount;
            generation['commandInputFailureCount'] = commandInputObservation.failureCount;
            generation['commandInputsTruncated'] = commandInputObservation.truncated;
          }
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
          recordFinishInputObservation(
            generation,
            result['content'],
            declaredNames,
            generationIndex,
          );
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
