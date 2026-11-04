import type { ApiErrorV1, ErrorCategoryV1 } from '../../api';

/** Freeze only newly constructed plain data; live capabilities need their own envelope. */
export function freezeValue<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (Array.isArray(value) || prototype === Object.prototype || prototype === null) {
      for (const child of Object.values(value)) freezeValue(child);
      Object.freeze(value);
    }
  }
  return value;
}

export function apiError(
  category: ErrorCategoryV1,
  code: string,
  message: string,
  diagnosticId?: string,
): ApiErrorV1 {
  return freezeValue({
    category,
    code,
    message,
    ...(diagnosticId === undefined ? {} : { diagnosticId }),
  });
}
