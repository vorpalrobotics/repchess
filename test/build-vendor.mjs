// Regenerate ./vendor/*.mjs — the locally-bundled copies of the CDN libraries
// the app imports. Only needed when a library VERSION in the app changes (the
// bundles are committed, so normal test runs don't rebuild them).
//
//   node build-vendor.mjs
//
// Versions here must match the CDN URLs in index.html / js/app.js / js/threeVR.js:
//   esm.sh/three@…            js/threeVR.js dynamic import
//   esm.sh/cytoscape@…        js/app.js
//   esm.sh/cytoscape-dagre@…  js/app.js
//   cdnjs …/chess.js/…        index.html <script>
import { execSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VERSIONS = {
  three: '0.160.0',
  cytoscape: '3.28.1',
  'cytoscape-dagre': '2.5.0',
  dagre: '0.8.5',        // cytoscape-dagre's peer dep, bundled in
  'chess.js': '0.10.3',
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

  console.log('\nvendor rebuilt in', VENDOR);
} finally {
  rmSync(work, { recursive: true, force: true });
}
