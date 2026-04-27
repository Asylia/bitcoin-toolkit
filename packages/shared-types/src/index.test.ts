import { describe, expect, expectTypeOf, it } from 'vitest';

import { ASYLIA_SHARED_TYPES_VERSION } from './index';

describe('@asylia/shared-types public runtime surface', () => {
  it('exports a stable dev-version marker', () => {
    expect(ASYLIA_SHARED_TYPES_VERSION).toBe('0.0.0-dev');
    expectTypeOf(ASYLIA_SHARED_TYPES_VERSION).toEqualTypeOf<'0.0.0-dev'>();
  });
});
