export { EXIT_CODES, exitCodeFor, type LassiErrorCode } from './codes.js';
export {
  LassiError,
  attachAliases,
  isLassiError,
  type LassiErrorInit,
  type HintContext,
  type Product,
  type RequestRef,
} from './lassi-error.js';
export { parseErrorEnvelope, type ErrorEnvelope } from './envelope.js';
export { classifyNetworkError, type NetworkErrorKind } from './network.js';
export {
  classifyHttpFailure,
  codeForStatus,
  fromNetworkError,
  type HttpFailure,
} from './classify.js';
export { pickHint } from './hints.js';
export { humanLine, toErrorJson, toStderr, type ErrorJson } from './render.js';
