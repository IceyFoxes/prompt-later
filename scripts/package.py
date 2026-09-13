from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
dist = root / 'dist'
release = root / 'release'
release.mkdir(parents=True, exist_ok=True)
out = release / 'prompt-later.zip'
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(dist.rglob('*')):
        if path.is_file():
            archive.write(path, path.relative_to(dist).as_posix())
print(out)
