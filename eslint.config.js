// JS lint gate for the Medic Tradeboard extension — a cyclomatic-complexity
// ratchet on the pure-logic core modules (the "LLMs write sprawling functions
// instead of units" guard). Behaviour is pinned by the 365 node:test cases;
// this only bounds complexity growth.
//
// Scope is core/*.js — pure logic per CLAUDE.md (no DOM, no chrome.*), the
// unambiguous ES modules the tests import. Content scripts, the service worker,
// and the drawer run in browser context and stay out of this gate.
//
// No node_modules is committed; CI runs it ephemerally:
//   npx --yes eslint@9 core/*.js
export default [
  {
    files: ["core/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      complexity: ["error", 20], // current peak is 17; 20 leaves headroom for real logic
    },
  },
];
