// Stockfish 10 pure-JS wrapper (same build used by ChessSight)
// Fetched via CDN and run in a blob Worker to avoid cross-origin restrictions.
const STOCKFISH_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js',
  'https://cdn.jsdelivr.net/npm/stockfish@10/stockfish.js',
  'https://cdn.jsdelivr.net/npm/stockfish@9/stockfish.js',
  'https://cdn.jsdelivr.net/npm/stockfish/stockfish.js',
];

export class Engine {
  constructor() {
    this._worker = null;
    this._listener = null;
    this.ready = false;
  }

  async init() {
    let blob = null;
    for (const url of STOCKFISH_URLS) {
      try {
        const res = await fetch(url);
        if (res.ok) { blob = await res.blob(); break; }
        console.warn(`Stockfish fetch failed (${res.status}): ${url}`);
      } catch (err) {
        console.warn(`Stockfish fetch error: ${url}`, err);
      }
    }
    if (!blob) throw new Error('Could not load Stockfish from any CDN source');
    const blobUrl = URL.createObjectURL(blob);

    this._worker = new Worker(blobUrl);
    this._worker.onmessage = ({ data }) => this._listener?.(data);

    await this._command('uci', line => line === 'uciok');
    await this._command('isready', line => line === 'readyok');
    this.ready = true;
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
  // { score: {type:'cp'|'mate', value}, pv: [uci moves...] }, both relative to
  // the side to move (as reported by the engine). With no `depth` (or
  // depth=Infinity) the search runs until stop() is called (or another
  // analyze() call supersedes it); otherwise it stops itself at that depth.
  async analyze(fen, { multipv = 4, depth = Infinity, onInfo } = {}) {
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
              pv: pvMatch[1].trim().split(' ')
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
      const goCmd = Number.isFinite(depth) ? `go depth ${depth}` : 'go infinite';
      console.debug(`[engine] ${goCmd} (multipv=${multipv}) fen=${fen}`);
      this._send(goCmd);
    });
  }

  stop() {
    this._send('stop');
  }
}
