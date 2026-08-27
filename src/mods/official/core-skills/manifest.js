import { CONTRACT_MAP } from '../../../contracts/symbols.js';

export const PROVIDES_CORE_SKILLS = Symbol.for('fate.provide.skills.core');

export default {
  id: 'official.core-skills',
  version: '1.0.0',
  type: 'content',
  provides: [PROVIDES_CORE_SKILLS],
  requires: [],
  contracts: CONTRACT_MAP,
};
