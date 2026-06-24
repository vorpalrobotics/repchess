// Two ways to load Stockfish, chosen at init() by whether the page is
// cross-origin isolated (see coi-serviceworker in index.html):
//
//   * Isolated  -> the multi-threaded "lite" build, vendored same-origin under
//     vendor/stockfish/. Multi-threading needs SharedArrayBuffer, which only
//     exists when crossOriginIsolated is true. The build spawns pthread Web
//     Workers that re-load this same script URL and resolve the .wasm next to
//     it, so it must be served from a normal same-origin path (a blob URL or a
//     cross-origin CDN breaks that self-resolution) — hence the vendored copy.
//
//   * Not isolated (Safari without credentialless, an old browser, or the
//     service worker not yet active) -> the single-threaded CDN build, exactly
//     as before. We fetch+blob the small .js loader to dodge cross-origin Worker
//     restrictions and point its #hash at the .wasm's absolute CDN URL.
//
// Single-threaded is always the safe fallback, so threading is a pure upgrade
// where the browser allows it and never a regression where it doesn't.
const THREADED_BUILD = {
  js:   'vendor/stockfish/stockfish-18-lite.js',
  wasm: 'vendor/stockfish/stockfish-18-lite.wasm',
};
const STOCKFISH_BUILDS = [
  { js: 'https://cdn.jsdelivr.net/npm/stockfish@18.0.8/bin/stockfish-18-lite-single.js',
    wasm: 'https://cdn.jsdelivr.net/npm/stockfish@18.0.8/bin/stockfish-18-lite-single.wasm' },
  { js: 'https://cdn.jsdelivr.net/npm/stockfish@18/bin/stockfish-18-lite-single.js',
    wasm: 'https://cdn.jsdelivr.net/npm/stockfish@18/bin/stockfish-18-lite-single.wasm' },
  { js: 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js' },
  { js: 'https://cdn.jsdelivr.net/npm/stockfish@10/stockfish.js' },
];

export class Engine {
  constructor() {
    this._worker = null;
    this._listener = null;
    this.ready = false;
    this.multithreaded = false;
    this.threads = 1;
  }

  async init() {
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
      && typeof SharedArrayBuffer !== 'undefined';
    if (isolated) {
      try {
        await this._initThreaded();
        return;
      } catch (err) {
        console.warn('[engine] multi-threaded init failed, falling back to single-threaded', err);
        this._teardownWorker();
      }
    }
    await this._initSingle();
  }

  // multi-threaded, same-origin: the worker self-locates its .wasm and its
  // pthread workers from this script's URL, so no blob indirection here.
  async _initThreaded() {
    const scriptUrl = new URL(THREADED_BUILD.js, document.baseURI).href;
    const wasmUrl   = new URL(THREADED_BUILD.wasm, document.baseURI).href;
    this._worker = new Worker(`${scriptUrl}#${encodeURIComponent(wasmUrl)}`);
    this._worker.onmessage = ({ data }) => this._listener?.(data);

    await this._command('uci', line => line === 'uciok');
    // leave a core for the UI/main thread; the lite build scales well to a
    // handful of threads but oversubscribing past that gives little back.
    const cores = navigator.hardwareConcurrency || 2;
    this.threads = Math.max(1, Math.min(cores - 1, 8));
    this._send(`setoption name Threads value ${this.threads}`);
    this._send('setoption name Hash value 128');
    await this._command('isready', line => line === 'readyok');
    this.multithreaded = true;
    this.ready = true;
    console.debug(`[engine] multi-threaded Stockfish ready (${this.threads} threads)`);
  }

  async _initSingle() {
    let blob = null, wasmUrl = null;
    for (const build of STOCKFISH_BUILDS) {
      try {
        const res = await fetch(build.js);
        if (res.ok) { blob = await res.blob(); wasmUrl = build.wasm || null; break; }
        console.warn(`Stockfish fetch failed (${res.status}): ${build.js}`);
      } catch (err) {
        console.warn(`Stockfish fetch error: ${build.js}`, err);
      }
    }
    if (!blob) throw new Error('Could not load Stockfish from any CDN source');
    let blobUrl = URL.createObjectURL(blob);
    if (wasmUrl) blobUrl += `#${encodeURIComponent(wasmUrl)}`;

    this._worker = new Worker(blobUrl);
    this._worker.onmessage = ({ data }) => this._listener?.(data);

    await this._command('uci', line => line === 'uciok');
    await this._command('isready', line => line === 'readyok');
    this.multithreaded = false;
    this.threads = 1;
    this.ready = true;
  }

  _teardownWorker() {
    if (this._worker) { try { this._worker.terminate(); } catch {} this._worker = null; }
    this._listener = null;
  }

  _send(cmd) {
    this._worker?.postMessage(cmd);
  }

  _command(cmd, isDone) {
    return new Promise(resolve => {
      this._listener = line => {
        if (isDone(line)) {
          this._listener = null;
          resolve(line);
        }
      };
      this._send(cmd);
    });
  }

  // Stops whatever search is currently running and waits for the engine to
  // confirm (its `bestmove` reply) before the caller installs a new listener,
  // so that reply can't be mistaken for the next search's result. Falls back
  // to a timeout so a missing/late `bestmove` can't wedge future searches.
  _stopCurrent() {
    if (!this._listener) return Promise.resolve();
    console.debug('[engine] stopping previous search');
    return new Promise(resolve => {
      let settled = false;
      const done = reason => {
        if (settled) return;
        settled = true;
        console.debug(`[engine] previous search stopped (${reason})`);
        resolve();
      };
      const prevListener = this._listener;
      this._listener = line => {
        prevListener(line);
        if (line.startsWith('bestmove')) done('bestmove received');
      };
      this._send('stop');
      setTimeout(() => {
        if (!settled) {
          console.warn('[engine] stop timed out waiting for bestmove; forcing listener clear');
          this._listener = null;
        }
        done('timeout');
      }, 4000);
    });
  }

  // Runs a multi-PV search on `fen`, calling onInfo(depth, lines) every time a
  // line updates. `lines` is keyed by PV rank (1..multipv), each entry is
  // { score: {type:'cp'|'mate', value}, pv: [uci moves...], depth }, score
  // relative to the side to move (as reported by the engine). `depth` is the
  // depth that *specific* PV rank last reported at — ranks update at slightly
  // different times, so don't assume they all share the depth passed to
  // onInfo (that's only the depth of whichever rank most recently changed).
  // With no `depth` (or depth=Infinity) the search runs until stop() is
  // called (or another analyze() call supersedes it); otherwise it stops
  // itself at that depth.
  // `searchmoves`, if given (array of UCI moves), restricts the root move
  // list to exactly those moves. Without it, a multipv count smaller than
  // the legal move count just gets the engine's own top-N moves by its own
  // judgment — any specific move you actually wanted ranked can fail to
  // appear at all, or can drop out partway through deepening once the
  // engine decides other (unrequested) moves are better, freezing its last
  // depth. searchmoves guarantees every listed move gets ranked among only
  // each other, so all of them keep reporting through to the target depth.
  async analyze(fen, { multipv = 4, depth = Infinity, searchmoves, onInfo } = {}) {
    await this._stopCurrent();
    this._send(`setoption name MultiPV value ${multipv}`);
    this._send(`position fen ${fen}`);

    const lines = {};
    let curDepth = 0;

    return new Promise(resolve => {
      this._listener = line => {
        if (line.startsWith('info')) {
          const depthMatch = line.match(/\bdepth (\d+)/);
          const mpvMatch    = line.match(/\bmultipv (\d+)/);
          const cpMatch     = line.match(/score cp (-?\d+)/);
          const mateMatch   = line.match(/score mate (-?\d+)/);
          const pvMatch     = line.match(/ pv (.+)$/);

          if (depthMatch && mpvMatch && pvMatch && (cpMatch || mateMatch)) {
            curDepth = parseInt(depthMatch[1], 10);
            const idx = parseInt(mpvMatch[1], 10);
            lines[idx] = {
              score: cpMatch
                ? { type: 'cp', value: parseInt(cpMatch[1], 10) }
                : { type: 'mate', value: parseInt(mateMatch[1], 10) },
              pv: pvMatch[1].trim().split(' '),
              depth: curDepth
            };
            onInfo?.(curDepth, lines);
          }
        }
        if (line.startsWith('bestmove')) {
          this._listener = null;
          console.debug(`[engine] bestmove received, final depth=${curDepth}`);
          resolve({ depth: curDepth, lines });
        }
      };
      const searchmovesPart = searchmoves?.length ? ` searchmoves ${searchmoves.join(' ')}` : '';
      const goCmd = (Number.isFinite(depth) ? `go depth ${depth}` : 'go infinite') + searchmovesPart;
      console.debug(`[engine] ${goCmd} (multipv=${multipv}) fen=${fen}`);
      this._send(goCmd);
    });
  }

  stop() {
    this._send('stop');
  }
}
