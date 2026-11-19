// Delete the local PGlite database and simulator state, so the next start re-seeds demo data.
import { rmSync } from 'node:fs';

rmSync('data', { recursive: true, force: true });
rmSync('.sim-state.json', { force: true });
console.log('Local demo database removed. Run `npm run dev` to recreate it.');
