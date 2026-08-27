export const PROVIDES_CORE_MAP = Symbol.for('fate.provide.map.core');

export default {
  id: 'official.core-map',
  version: '1.0.0',
  type: 'system',
  provides: [PROVIDES_CORE_MAP],
  requires: [],
};
