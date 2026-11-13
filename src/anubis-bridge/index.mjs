import { AnubisCompatibilityBridge } from '../anubis-bridge.mjs';
import { Anubis127Adapter } from './v127/adapter.mjs';

// Explicit route opt-in only. This is an implementation registry, not a claim
// that either version has passed production authentication verification.
export function createAnubisBridge(options) {
  switch (options?.supportedVersion) {
    case '1.27.0': return new Anubis127Adapter(options);
    case '1.28.2': return new AnubisCompatibilityBridge(options);
    default: throw new Error('unsupported Anubis version for adapter selection');
  }
}
