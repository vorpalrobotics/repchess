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
  // so that reply can't be mistaken for the next search's result.
  _stopCurrent() {
    if (!this._listener) return Promise.resolve();
    return new Promise(resolve => {
      const prevListener = this._listener;
      this._listener = line => {
        prevListener(line);
        if (line.startsWith('bestmove')) resolve();
      };
      this._send('stop');
    });
  }

  // Runs an unbounded multi-PV search on `fen`, calling onInfo(depth, lines)
  // every time a line updates. `lines` is keyed by PV rank (1..multipv), each
  // entry is { score: {type:'cp'|'mate', value}, pv: [uci moves...] }, both
  // relative to the side to move (as reported by the engine). The search runs
  // until stop() is called (or another analyze() call supersedes it).
  async analyze(fen, { multipv = 4, onInfo } = {}) {
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
          resolve({ depth: curDepth, lines });
        }
      };
      this._send('go infinite');
    });
  }

  stop() {
    this._send('stop');
  }
}
