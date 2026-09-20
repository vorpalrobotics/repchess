// Regenerate ./vendor/*.mjs — the locally-bundled copies of the CDN libraries
// the app imports. Only needed when a library VERSION in the app changes (the
// bundles are committed, so normal test runs don't rebuild them).
//
//   node build-vendor.mjs
//
// Versions here must match the CDN URLs in index.html / js/app.js / js/threeVR.js:
//   esm.sh/three@…                     js/threeVR.js dynamic import
//   esm.sh/cytoscape@…                 js/app.js
//   esm.sh/cytoscape-dagre@…           js/app.js
//   cdnjs …/chess.js/…                 index.html <script>
//   unpkg …/cm-chessboard@…/pieces/…   js/app.js PIECES_FILE (only the piece
//                                      sprite is vendored, not the JS widget)
//
// It ALSO builds the one library the app self-hosts rather than fetching from
// a CDN: @toast-ui/editor, into ../js/vendor/. See js/notes.js's header for
// why -- its published dist is not a working browser bundle, and its only
// standalone build lives on a CDN the test sandbox cannot reach.
import { execSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VERSIONS = {
  three: '0.160.0',
  cytoscape: '3.28.1',
  'cytoscape-dagre': '2.5.0',
  dagre: '0.8.5',        // cytoscape-dagre's peer dep, bundled in
  'chess.js': '0.10.3',
  'cm-chessboard': '8',  // only assets/pieces/standard.svg is used from this
  '@toast-ui/editor': '3.2.2',   // self-hosted; see the note above
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, 'vendor');

const work = mkdtempSync(path.join(tmpdir(), 'repchess-vendor-'));
try {
  writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'v', private: true }));
  const specs = Object.entries(VERSIONS).map(([n, v]) => `${n}@${v}`).join(' ');
  console.log('installing', specs);
  execSync(`npm install --no-audit --no-fund esbuild ${specs}`, { cwd: work, stdio: 'inherit' });

  const esbuild = path.join(work, 'node_modules/.bin/esbuild');
  const bundle = (entry, out) =>
    execSync(`${esbuild} ${entry} --bundle --format=esm --outfile="${path.join(VENDOR, out)}"`,
             { cwd: work, stdio: 'inherit' });

  // three ships a complete ESM build — copy it verbatim
  copyFileSync(path.join(work, 'node_modules/three/build/three.module.js'), path.join(VENDOR, 'three.mjs'));
  // cytoscape: re-export the package's default (its ESM entry)
  writeFileSync(path.join(work, 'cyto.mjs'), "export {default} from 'cytoscape';");
  bundle('cyto.mjs', 'cytoscape.mjs');
  // cytoscape-dagre: CJS plugin + its dagre dep, bundled to an ESM default export
  writeFileSync(path.join(work, 'cdagre.mjs'), "import m from 'cytoscape-dagre';export default m;");
  bundle('cdagre.mjs', 'cytoscape-dagre.mjs');
  // chess.js 0.10.3 is a UMD browser global (window.Chess) — serve as-is
  copyFileSync(path.join(work, 'node_modules/chess.js/chess.js'), path.join(VENDOR, 'chess.js'));
  // cm-chessboard: just the piece sprite SVG (static asset, no bundling needed)
  copyFileSync(path.join(work, 'node_modules/cm-chessboard/assets/pieces/standard.svg'),
               path.join(VENDOR, 'cm-chessboard-standard.svg'));
  /* toast-ui editor -> ../js/vendor/, the app's own origin. Bundled here
     rather than copied: the package's dist/toastui-editor.js hands `undefined`
     to all eight of its externals on the browser path, so ProseMirror is
     missing and it dies on PluginKey without defining its global. esbuild
     inlines the dependencies and gives a clean ESM default export. */
  const APP_VENDOR = path.join(HERE, '..', 'js', 'vendor');
  mkdirSync(APP_VENDOR, { recursive: true });
  writeFileSync(path.join(work, 'toast.mjs'), "import Editor from '@toast-ui/editor';export default Editor;");
  execSync(`${esbuild} toast.mjs --bundle --format=esm --outfile="${path.join(APP_VENDOR, 'toastui-editor.mjs')}"`,
           { cwd: work, stdio: 'inherit' });
  copyFileSync(path.join(work, 'node_modules/@toast-ui/editor/dist/toastui-editor.css'),
               path.join(APP_VENDOR, 'toastui-editor.css'));

  console.log('\nvendor rebuilt in', VENDOR);
} finally {
  rmSync(work, { recursive: true, force: true });
}
