/**
 * `essentia.js` ships no type declarations for its `dist` bundles.
 *
 * Only `key-essentia.ts` imports them, and it narrows what it gets to its own
 * `EssentiaLike` interface immediately - so a precise declaration here would be a second,
 * drifting copy of that shape rather than a check on anything. `unknown` keeps the two
 * imports from being implicit `any` under `noImplicitAny` while leaving the real narrowing
 * where it belongs.
 */
declare module 'essentia.js/dist/essentia-wasm.es.js' {
  const EssentiaWASM: unknown
  export { EssentiaWASM }
  export default EssentiaWASM
}

declare module 'essentia.js/dist/essentia.js-core.es.js' {
  const Essentia: unknown
  export { Essentia }
  export default Essentia
}
