// Bundles the standalone LAN relay (trial) into one plain-Node file:
// dist/apps/multiplex-relay/main.js, plus the host-side forwarder.js. It
// reuses the multiplex engine from this project's sources and has no
// Electron dependency at runtime.
const esbuild = require('esbuild');
const path = require('path');

const root = path.join(__dirname, '../..');
// A scratch build (for example a test of the launcher) can go elsewhere.
const outdir =
    process.env.MULTIPLEX_RELAY_OUTDIR ||
    path.join(root, 'dist/apps/multiplex-relay');

esbuild
    .build({
        entryPoints: {
            main: path.join(__dirname, 'src/app/multiplex/lan-relay/main.ts'),
            // Host-side LAN forwarder (runs outside the VPN namespace).
            forwarder: path.join(
                __dirname,
                'src/app/multiplex/lan-relay/forwarder-main.ts'
            ),
        },
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'cjs',
        outdir,
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
    .then(() => console.log(`Built ${outdir}/{main,forwarder}.js`))
    .catch(() => process.exit(1));
