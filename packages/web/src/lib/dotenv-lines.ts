// One parser for the server and the cockpit (spec 2026-10-21-env-references): it lives in the contract.
export {
  ENV_KEY_PATTERN,
  addVariable,
  duplicateKeys,
  formatAssignment,
  parseEnv,
  removeLine,
  serializeEnv,
  setVariable,
  type EnvLine,
} from '@open-mercato/cezar-api-client'
