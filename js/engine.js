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
// how long to wait for the worker's first response (uci -> uciok, then
// isready -> readyok) during init. Generous because a cold wasm fetch/compile
// can genuinely take a while on a slow connection/device; the point isn't to
// be tight, it's to eventually fail instead of hanging forever.
const INIT_TIMEOUT_MS = 20000;

export class Engine {
  constructor() {
    this._worker = null;
    this._listener = null;
    this.ready = false;
    this.multithreaded = false;
    this.threads = 1;       // the DEFAULT thread count init() picked (conservative --
                             // see _initThreaded -- scales well without much more to gain)
    this.maxThreads = 1;    // the ceiling analyze()'s `threads` override can ask for:
                             // cores-1, uncapped, so a caller can deliberately go past
                             // the conservative default when they want it to go faster
    this._currentThreads = 1;   // whatever Threads value is actually configured right now
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

    await this._commandWithTimeout('uci', line => line === 'uciok', INIT_TIMEOUT_MS);
    // leave a core for the UI/main thread; the lite build scales well to a
    // handful of threads but oversubscribing past that gives little back, so
    // the DEFAULT stays conservative even though maxThreads (the ceiling a
    // caller can deliberately ask for via analyze()'s `threads` override)
    // goes all the way to cores-1.
    const cores = navigator.hardwareConcurrency || 2;
    this.maxThreads = Math.max(1, cores - 1);
    this.threads = Math.min(this.maxThreads, 8);
    this._send(`setoption name Threads value ${this.threads}`);
    this._currentThreads = this.threads;
    this._send('setoption name Hash value 128');
    await this._commandWithTimeout('isready', line => line === 'readyok', INIT_TIMEOUT_MS);
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

    await this._commandWithTimeout('uci', line => line === 'uciok', INIT_TIMEOUT_MS);
    await this._commandWithTimeout('isready', line => line === 'readyok', INIT_TIMEOUT_MS);
    this.multithreaded = false;
    this.threads = 1;
    this.maxThreads = 1;
    this._currentThreads = 1;
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

  // Like _command, but used only for the init handshakes (uci/uciok,
  // isready/readyok on a freshly-constructed worker) where there's no
  // fallback path yet if the worker never responds. Unlike _command, this
  // can actually fail: it rejects if the worker fires its 'error' event
  // (a real runtime failure -- bad script, wasm load failure, etc. -- as
  // opposed to a fetch()-level failure, which _initSingle's CDN loop
  // already handles before a worker even exists) or if timeoutMs elapses
  // with no response, instead of leaving the caller awaiting a promise
  // that can hang forever with no error and no console diagnostic.
  _commandWithTimeout(cmd, isDone, timeoutMs) {
    return new Promise((resolve, reject) => {
      const worker = this._worker;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('error', onError);
      };
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`engine worker error while waiting for "${cmd}": ${err?.message || err}`));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this._listener = null;
        reject(new Error(`engine handshake timed out waiting for a response to "${cmd}"`));
      }, timeoutMs);
      worker.addEventListener('error', onError);
      this._listener = line => {
        if (isDone(line)) {
          if (settled) return;
          settled = true;
          cleanup();
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
  // `threads`, when given (multi-threaded builds only -- ignored otherwise),
  // overrides the Threads option for just this search, clamped to maxThreads
  // (cores-1, not the conservative `threads` default -- lets a caller
  // deliberately ask for more than init()'s own pick). Only re-sent when it
  // actually differs from what's currently configured, and, when it does
  // change, followed by an isready/readyok handshake before the next `go`:
  // changing Threads makes a multi-threaded WASM build respawn its whole
  // pthread pool in the background, and searching before that settles can
  // wedge the worker so it never responds to anything again (this was a
  // real bug -- the background analysis queue used to pass a reduced thread
  // count, the first thing in the app to ever change Threads after init,
  // with no such handshake, and could hang the engine on its very first
  // search; the queue still doesn't override threads -- interrupting an
  // already-running search for a Threads change isn't worth it for
  // unattended background work -- but the live engine panel's thread-count
  // selector does, safely, now that this handshake exists).
  async analyze(fen, { multipv = 4, depth = Infinity, searchmoves, onInfo, threads = this.threads } = {}) {
    await this._stopCurrent();
    let threadsFallback = null;
    if (this.multithreaded) {
      const clampedThreads = Math.max(1, Math.min(threads, this.maxThreads));
      if (clampedThreads !== this._currentThreads) {
        // race a timeout too (like _stopCurrent's) so a missing/late readyok
        // can't wedge the app forever -- worst case we search a beat early.
        const trySetThreads = async n => {
          this._send(`setoption name Threads value ${n}`);
          return await Promise.race([
            this._command('isready', line => line === 'readyok').then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 4000)),
          ]);
        };
        const ack = await trySetThreads(clampedThreads);
        if (ack) {
          this._currentThreads = clampedThreads;
        } else {
          // navigator.hardwareConcurrency (what maxThreads is derived from)
          // can overstate what this browser/OS will actually let a WASM
          // build spin up as pthread workers -- if the requested count
          // never acked, DON'T just barrel on into a search on whatever
          // half-respawned state the pthread pool is now in (that's what
          // used to silently wedge the engine for good, with nothing ever
          // reaching bestmove again). Instead, fall back to _currentThreads
          // -- the last count that's actually known to have acked -- and
          // only proceed once THAT'S reconfirmed. If even that doesn't ack,
          // the worker itself is wedged, not just this particular thread
          // count, so give up loudly instead of hanging forever.
          console.warn(`[engine] Threads -> ${clampedThreads} didn't ack in time, falling back to ${this._currentThreads}`);
          const fallbackAck = await trySetThreads(this._currentThreads);
          if (!fallbackAck) {
            throw new Error(`engine unresponsive after a Threads change to ${clampedThreads} -- the worker may need a reload`);
          }
          threadsFallback = { requested: clampedThreads, using: this._currentThreads };
        }
      }
    }
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
          resolve(threadsFallback ? { depth: curDepth, lines, threadsFallback } : { depth: curDepth, lines });
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
