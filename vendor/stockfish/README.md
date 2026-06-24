# Vendored Stockfish (multi-threaded WASM)

These are **unmodified** build artifacts of Stockfish.js 18 (the "lite,
multi-threaded" build) copied verbatim from the npm package
[`stockfish@18.0.8`](https://www.npmjs.com/package/stockfish)
(`bin/stockfish-18-lite.js` + `bin/stockfish-18-lite.wasm`).

- Upstream: https://github.com/nmrugg/stockfish.js
- Engine:   https://github.com/official-stockfish/Stockfish
- License:  **GPLv3** (see the header inside `stockfish-18-lite.js`)

They are vendored (served same-origin) rather than loaded from a CDN because the
multi-threaded build spawns pthread Web Workers that re-load this same script URL
and resolve the `.wasm` next to it — which only works reliably from a normal
same-origin path, and also sidesteps cross-origin (COEP) subresource rules. The
single-threaded CDN build remains the fallback when the page is not
cross-origin-isolated (see `js/engine.js`).
