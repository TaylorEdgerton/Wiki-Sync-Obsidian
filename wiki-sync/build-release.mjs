import { cp, mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const defaultOutputDir = path.join(__dirname, 'release', manifest.id);
const outputDir = path.resolve(process.env.WIKI_SYNC_OUT_DIR || defaultOutputDir);

const managedEntries = [
    'main.js',
    'main.js.map',
    'main.js.LEGAL.txt',
    'manifest.json',
    'LICENSE',
    'NOTICE',
    'templates',
];

async function removeManagedEntries(dir) {
    for (const entry of managedEntries) {
        await rm(path.join(dir, entry), { recursive: true, force: true });
    }
}

await mkdir(outputDir, { recursive: true });
await removeManagedEntries(outputDir);

await build({
    entryPoints: [path.join(__dirname, 'main.js')],
    outfile: path.join(outputDir, 'main.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['obsidian', 'electron', 'pg-native', 'pg-cloudflare'],
    sourcemap: false,
    legalComments: 'inline',
    logLevel: 'info',
});

await Promise.all([
    copyFile(manifestPath, path.join(outputDir, 'manifest.json')),
    copyFile(path.join(__dirname, 'LICENSE'), path.join(outputDir, 'LICENSE')),
    copyFile(path.join(__dirname, 'NOTICE'), path.join(outputDir, 'NOTICE')),
    cp(path.join(__dirname, 'templates'), path.join(outputDir, 'templates'), { recursive: true }),
]);

console.log(`Wiki Sync release written to ${outputDir}`);
if (!process.env.WIKI_SYNC_OUT_DIR) {
    console.log('Set WIKI_SYNC_OUT_DIR to build directly into a Windows Obsidian plugin folder mounted under /mnt/c.');
}
