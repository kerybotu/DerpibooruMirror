// Anubis 1.27.0: lib/config.go registers GET; challenge implementations read
// query strings via FormValue. Values remain opaque apart from wire format.
export function validatePassChallenge(parameters, method) {
  if (method !== 'GET') throw new Error('v1.27.0 PassChallenge requires GET');
  function required(name) {
    const values = parameters.getAll(name);
    if (values.length !== 1 || !values[0] || /[\u0000-\u001f\u007f]/.test(values[0])) {
      throw new Error(`v1.27.0 PassChallenge requires exactly one nonempty ${name}`);
    }
    return values[0];
  }
  required('id');
  required('redir');
  const pow = ['nonce', 'elapsedTime', 'response'].some(key => parameters.has(key));
  const preact = parameters.has('result');
  const metarefresh = parameters.has('challenge');
  if (Number(pow) + Number(preact) + Number(metarefresh) !== 1) {
    throw new Error('v1.27.0 PassChallenge requires one challenge response contract');
  }
  if (pow) {
    const nonce = required('nonce');
    // Go amd64 strconv.Atoi accepts signed decimal int64. Preserve its text:
    // the PoW digest is calculated over the original nonce string upstream.
    if (!/^[+-]?\d+$/.test(nonce) || BigInt(nonce) < -(2n ** 63n) || BigInt(nonce) >= 2n ** 63n) {
      throw new Error('v1.27.0 PassChallenge nonce must be an int64 string');
    }
    const elapsed = required('elapsedTime');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(elapsed) || !Number.isFinite(Number(elapsed))) {
      throw new Error('v1.27.0 PassChallenge elapsedTime must be a finite decimal string');
    }
    if (!/^[a-f0-9]{64}$/.test(required('response'))) throw new Error('v1.27.0 PassChallenge response must be a SHA256 hex string');
  } else if (preact) {
    if (!/^[a-f0-9]{64}$/.test(required('result'))) throw new Error('v1.27.0 PassChallenge result must be a SHA256 hex string');
  } else {
    required('challenge');
  }
}
