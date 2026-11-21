// Bundles the standalone LAN relay (trial) into one plain-Node file:
// dist/apps/multiplex-relay/main.js. It reuses the multiplex engine from
// this project's sources and has no Electron dependency at runtime.
const esbuild = require('esbuild');
const path = require('path');

const root = path.join(__dirname, '../..');

esbuild
    .build({
        entryPoints: [
            path.join(__dirname, 'src/app/multiplex/lan-relay/main.ts'),
        ],
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        outfile: path.join(root, 'dist/apps/multiplex-relay/main.js'),
        tsconfig: path.join(root, 'tsconfig.base.json'),
        // Electron must never be pulled in; fail the build if it is.
        plugins: [
            {
                name: 'no-electron',
                setup(build) {
                    build.onResolve({ filter: /^electron$/ }, () => ({
                        errors: [{ text: 'electron must not be bundled' }],
                    }));
                },
            },
        ],
        sourcemap: true,
        logLevel: 'warning',
    })
    .then(() => console.log('Built dist/apps/multiplex-relay/main.js'))
    .catch(() => process.exit(1));
