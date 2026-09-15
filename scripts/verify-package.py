from pathlib import Path
import hashlib
import json
import os
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXPECTED_FILES = {
    'manifest.json', 'app.html', 'styles.css', 'app.js', 'content.js', 'worker.js',
    'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
}


def verify_package(archive_path, dist):
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != EXPECTED_FILES:
            raise ValueError('The package contains missing, duplicate, or unexpected files.')
        if sum(info.file_size for info in archive.infolist()) > 20 * 1024 * 1024:
            raise ValueError('The package exceeds the verification size limit.')
        for name in names:
            if archive.read(name) != (dist / name).read_bytes():
                raise ValueError('The archive does not match the tested distribution.')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest != json.loads((ROOT / 'manifest.json').read_text()):
            raise ValueError('The package manifest differs from the source manifest.')
    return {
        'version': manifest['version'],
        'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
    }


if __name__ == '__main__':
    result = verify_package(ROOT / 'release' / 'prompt-later.zip', ROOT / 'dist')
    print(f"Verified package {result['version']}; SHA-256 {result['sha256']}")
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf8') as destination:
            destination.write(f"version={result['version']}\nsha256={result['sha256']}\n")
