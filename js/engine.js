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
    this._currentHash = 0;      // whatever Hash (MB) value is actually configured right now -- see init()/analyze()
    this._initPromise = null;   // in-flight init() call, if any -- see init()
  }

  // Callers don't coordinate: app.js calls this unconditionally at boot AND
  // (guarded by `if(!engine.ready)`) from runEngine() on any live-analysis
  // request, which can easily fire while the cold WASM fetch/compile from
  // the FIRST call is still in flight (that's exactly why INIT_TIMEOUT_MS is
  // as generous as it is). Without this guard, two concurrent calls would
  // each create their own Worker and both read/write the same _worker/
  // _listener fields with no locking -- if the slower one times out because
  // the faster one reassigned _listener out from under it, its cleanup path
  // would call _teardownWorker(), terminating whichever Worker _worker
  // currently points to, which by then could be the OTHER call's already-
  // working one. A concurrent second caller instead just awaits this same
  // in-flight attempt; the promise is cleared once it settles so a later,
  // non-concurrent call can still retry after a genuine failure.
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().finally(() => { this._initPromise = null; });
    return this._initPromise;
  }

  async _doInit() {
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
    // 512MB (was 128) -- nothing here ever sends `ucinewgame`, so this
    // transposition table stays warm across every analyze() call for the
    // life of the worker (position/go per call, never cleared), and a
    // background-only, potentially multi-day search like Perfect Opening's
    // genuinely benefits from more headroom before entries start getting
    // overwritten. A caller can still override per search via analyze()'s
    // own `hash` option (see there for why that resets the table's contents).
    this._send('setoption name Hash value 512');
    this._currentHash = 512;
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

    // The URL is only ever needed to construct the Worker above; hang onto
    // it just long enough to know whether that actually took (success or
    // failure), then revoke it -- otherwise it leaks the underlying Blob for
    // the rest of the page's life.
    try {
      await this._commandWithTimeout('uci', line => line === 'uciok', INIT_TIMEOUT_MS);
      // previously left unset here (unlike _initThreaded), silently falling
      // back to Stockfish's own tiny built-in default (typically 16MB) --
      // a single-threaded fallback usually means a more constrained device/
      // browser, so a modest explicit bump rather than _initThreaded's 512.
      this._send('setoption name Hash value 64');
      this._currentHash = 64;
      await this._commandWithTimeout('isready', line => line === 'readyok', INIT_TIMEOUT_MS);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
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

  // Sends `cmd` and resolves once a response line matches `isDone`, or
  // rejects if the worker fires its 'error' event (a real runtime failure --
  // bad script, wasm load failure, etc. -- as opposed to a fetch()-level
  // failure, which _initSingle's CDN loop already handles before a worker
  // even exists) or if timeoutMs elapses with no response. Every settle path
  // (resolve, error, timeout) clears _listener itself, so a caller can never
  // leave a stale listener installed behind a losing race the way a bare
  // Promise.race over an unclearable listener would.
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
        this._listener = null;
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
  // `hash` (MB), when given, overrides the Hash option for just this search
  // -- also only re-sent when it differs from what's currently configured.
  // Unlike Threads this doesn't respawn a pthread pool, just reallocates the
  // transposition table, so a missed ack isn't a wedge risk the same way --
  // worst case the search just runs one beat early against whichever size
  // is still actually configured. IMPORTANT: resizing Hash empties the
  // table's contents (a fresh allocation, not a resize-in-place), so a
  // caller relying on cross-search cache warmth (Perfect Opening, walking a
  // tree of related positions over a long unattended run) should treat this
  // as a "set once and leave it" value, not something to fluctuate per call.
  async analyze(fen, { multipv = 4, depth = Infinity, searchmoves, onInfo, threads = this.threads, hash = this._currentHash } = {}) {
    await this._stopCurrent();
    let threadsFallback = null;
    if (this.multithreaded) {
      const clampedThreads = Math.max(1, Math.min(threads, this.maxThreads));
      if (clampedThreads !== this._currentThreads) {
        // Times out its own wait (like _stopCurrent's) so a missing/late
        // readyok can't wedge the app forever -- worst case we search a beat
        // early -- but unlike a bare Promise.race over _command(), the
        // timeout branch here clears _listener itself. A plain race can't do
        // that: nothing cancels the loser, it's just ignored, so a doubly-
        // timed-out Threads change used to leave _command's listener
        // installed. The NEXT analyze() call's _stopCurrent() would then see
        // that stale listener, assume a real search was running, and burn
        // its own ~4s timeout waiting for a bestmove that was never coming --
        // the exact "occasional 4s stall" this was reported as. (Deliberately
        // not _commandWithTimeout here -- that also needs a real `_worker` to
        // listen for its 'error' event, which this path doesn't otherwise
        // depend on and which the engine.js tests don't fake.)
        const trySetThreads = n => {
          this._send(`setoption name Threads value ${n}`);
          return new Promise(resolve => {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              this._listener = null;
              resolve(false);
            }, 4000);
            this._listener = line => {
              if (line !== 'readyok' || settled) return;
              settled = true;
              clearTimeout(timer);
              this._listener = null;
              resolve(true);
            };
            this._send('isready');
          });
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
    if (hash !== this._currentHash) {
      this._send(`setoption name Hash value ${hash}`);
      this._currentHash = hash;
      await new Promise(resolve => {
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; this._listener = null; resolve(); } }, 4000);
        this._listener = line => {
          if (line !== 'readyok' || settled) return;
          settled = true;
          clearTimeout(timer);
          this._listener = null;
          resolve();
        };
        this._send('isready');
      });
    }
    this._send(`setoption name MultiPV value ${multipv}`);
    this._send(`position fen ${fen}`);

    const lines = {};
    let curDepth = 0;
    let lastNps = 0;   // nodes/sec from the most recent `info` line that reported one

    return new Promise(resolve => {
      this._listener = line => {
        if (line.startsWith('info')) {
          // nps shows up on most periodic info lines independently of a full
          // depth/multipv/score/pv match (e.g. it can arrive without a pv on
          // some lines) -- parsed separately so a search's last-known speed
          // survives even when this particular line doesn't otherwise qualify.
          const npsMatch = line.match(/\bnps (\d+)/);
          if (npsMatch) lastNps = parseInt(npsMatch[1], 10);

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
          resolve({ depth: curDepth, lines, nps: lastNps, ...(threadsFallback ? { threadsFallback } : {}) });
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
