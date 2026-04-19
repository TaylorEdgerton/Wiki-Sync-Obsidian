import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [releaseDirArg, archivePathArg] = process.argv.slice(2);

if (!releaseDirArg || !archivePathArg) {
    console.error('Usage: node scripts/create-release-archive.mjs <releaseDir> <archivePath>');
    process.exit(1);
}

const releaseDir = path.resolve(releaseDirArg);
const archivePath = path.resolve(archivePathArg);

await stat(releaseDir).catch(() => {
    console.error(`Release directory does not exist: ${releaseDir}`);
    process.exit(1);
});

await mkdir(path.dirname(archivePath), { recursive: true });
await rm(archivePath, { force: true });

function commandExists(command) {
    const checker = process.platform === 'win32' ? 'where' : 'command';
    const args = process.platform === 'win32' ? [command] : ['-v', command];
    const result = spawnSync(checker, args, { stdio: 'ignore', shell: process.platform !== 'win32' });
    return result.status === 0;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        ...options,
    });
    if (result.status !== 0) {
        throw new Error(`${command} exited with code ${result.status ?? 'unknown'}`);
    }
}

if (process.platform === 'win32' && commandExists('powershell.exe')) {
    run('powershell.exe', [
        '-NoProfile',
        '-Command',
        [
            `$source = ${JSON.stringify(path.join(releaseDir, '*'))}`,
            `$dest = ${JSON.stringify(archivePath)}`,
            'Compress-Archive -Path $source -DestinationPath $dest -Force',
        ].join('; '),
    ]);
    process.exit(0);
}

if (process.platform === 'win32' && commandExists('pwsh')) {
    run('pwsh', [
        '-NoProfile',
        '-Command',
        [
            `$source = ${JSON.stringify(path.join(releaseDir, '*'))}`,
            `$dest = ${JSON.stringify(archivePath)}`,
            'Compress-Archive -Path $source -DestinationPath $dest -Force',
        ].join('; '),
    ]);
    process.exit(0);
}

if (commandExists('zip')) {
    run('zip', ['-qr', archivePath, '.'], { cwd: releaseDir });
    process.exit(0);
}

const python = commandExists('python3') ? 'python3' : (commandExists('python') ? 'python' : '');
if (python) {
    run(python, [
        '-c',
        [
            'import os, sys, zipfile',
            'release_dir = sys.argv[1]',
            'archive_path = sys.argv[2]',
            'with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:',
            '    for root, _, files in os.walk(release_dir):',
            '        for name in files:',
            '            full = os.path.join(root, name)',
            '            rel = os.path.relpath(full, release_dir)',
            '            zf.write(full, rel)',
        ].join('\n'),
        releaseDir,
        archivePath,
    ]);
    process.exit(0);
}

console.error('Could not create release archive: no supported archive tool was found. Install powershell, zip, or python.');
process.exit(1);