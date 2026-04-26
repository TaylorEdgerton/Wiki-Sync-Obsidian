import { cp, mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const defaultOutputDir = path.join(__dirname, 'release', manifest.id);
const outputDir = path.resolve(process.env.WIKI_SYNC_OUT_DIR || defaultOutputDir);
const helperSourceDir = path.resolve(__dirname, '..', 'wiki-helper');

const managedEntries = [
    'main.js',
    'main.js.map',
    'main.js.LEGAL.txt',
    'manifest.json',
    'LICENSE',
    'NOTICE',
    'templates',
    'wiki-helper',
];

async function removeEntry(entryPath) {
    try {
        await rm(entryPath, { recursive: true, force: true });
    } catch (err) {
        if (err.code !== 'EACCES' || !entryPath.startsWith('/mnt/')) throw err;
        // WSL2: Windows-filesystem rmdir fails with EACCES when a Windows process
        // (e.g. Obsidian) holds the plugin directory open — fall back to cmd.exe.
        const { stdout } = await execFileAsync('wslpath', ['-w', entryPath]);
        await execFileAsync('cmd.exe', ['/c', 'rmdir', '/s', '/q', stdout.trim()]).catch(() => {});
    }
}

async function removeManagedEntries(dir) {
    for (const entry of managedEntries) {
        await removeEntry(path.join(dir, entry));
    }
}

async function copyHelperBundle(dir) {
    const targetDir = path.join(dir, 'wiki-helper');
    const includeRuntimeFile = source => {
        const parts = source.split(path.sep);
        return !parts.includes('__pycache__') && !source.endsWith('.pyc');
    };
    await mkdir(targetDir, { recursive: true });
    await Promise.all([
        copyFile(path.join(helperSourceDir, 'README.md'), path.join(targetDir, 'README.md')),
        copyFile(path.join(helperSourceDir, 'pyproject.toml'), path.join(targetDir, 'pyproject.toml')),
        copyFile(path.join(helperSourceDir, 'requirements.txt'), path.join(targetDir, 'requirements.txt')),
        cp(path.join(helperSourceDir, 'schema'), path.join(targetDir, 'schema'), { recursive: true }),
        cp(path.join(helperSourceDir, 'src'), path.join(targetDir, 'src'), {
            recursive: true,
            filter: includeRuntimeFile,
        }),
    ]);
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
    copyHelperBundle(outputDir),
]);

console.log(`Wiki Sync release written to ${outputDir}`);
if (!process.env.WIKI_SYNC_OUT_DIR) {
    console.log('Set WIKI_SYNC_OUT_DIR to build directly into a Windows Obsidian plugin folder mounted under /mnt/c.');
}
