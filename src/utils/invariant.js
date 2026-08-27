/** 自定义错误类型与断言工具。所有错误携带机器可读的 code，便于 UI 分类展示。 */

export class FateError extends Error {
  constructor(message, { code, cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FateError';
    this.code = code ?? 'FATE_ERROR';
    this.details = details ?? null;
  }
}

export class DeterminismError extends FateError {
  constructor(message, details) {
    super(message, { code: 'DETERMINISM_VIOLATION', details });
    this.name = 'DeterminismError';
  }
}

export class UnknownContractError extends FateError {
  constructor(key) {
    super(`未注册的契约：${key}`, { code: 'UNKNOWN_CONTRACT', details: { key } });
    this.name = 'UnknownContractError';
  }
}

export class ModLoadError extends FateError {
  constructor(message, details) {
    super(message, { code: 'MOD_LOAD_FAILED', details });
    this.name = 'ModLoadError';
  }
}

export class MapGenerationError extends FateError {
  constructor(message, details) {
    super(message, { code: 'MAP_GENERATION_FAILED', details });
    this.name = 'MapGenerationError';
  }
}

export class ContractViolationError extends FateError {
  constructor(message, details) {
    super(message, { code: 'CONTRACT_VIOLATION', details });
    this.name = 'ContractViolationError';
  }
}

export function invariant(condition, message, details) {
  if (!condition) {
    throw new FateError(message, { code: 'INVARIANT_FAILED', details });
  }
  return condition;
}

/** 校验值为非负整数。用于所有毫秒量纲字段。 */
export function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new FateError(`${label} 必须是非负整数，实际为 ${String(value)}`, {
      code: 'INVALID_INTEGER',
      details: { label, value },
    });
  }
  return value;
}

export function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new FateError(`${label} 必须是正整数，实际为 ${String(value)}`, {
      code: 'INVALID_INTEGER',
      details: { label, value },
    });
  }
  return value;
}
