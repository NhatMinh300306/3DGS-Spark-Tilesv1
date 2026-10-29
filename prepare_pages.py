#!/usr/bin/env python3
"""Prepare docs for GitHub Pages, including every RAD/RADC/PLY in dist/data.

CMD: py prepare_pages.py
Use --frontend-only to preserve a dataset already in docs without copying it.
No destination files are deleted. No Git commands run automatically.
"""
import argparse
import json
import shutil
from pathlib import Path

from configure_dataset import scan_dataset, write_index
from configure_tiles import prepare_tiles
from tools.package_source import package_source

REQUIRED_FRONTEND = ('index.html', 'app.js', 'ui.js', 'sequence.js', 'tiles.js', 'scenes.js', 'style.css')


def prepare_data(source):
    source = Path(source)
    found = False
    if (source / 'data' / 'redandblack-pages').is_dir():
        write_index(source, scan_dataset(source))
        found = True
    tiles_root = source / 'data' / 'redandblack_tiles'
    if tiles_root.is_dir():
        options = {}
        existing = tiles_root / 'tiles.json'
        if existing.is_file():
            manifest = json.loads(existing.read_text(encoding='utf-8'))
            selected = [frame['id'] for frame in manifest['layers'][0]['frames']]
            options = dict(default_layer=manifest.get('defaultLayer'), fps=manifest.get('fps', 30),
                           rotation=manifest.get('rotationX', 0), start=min(selected), end=max(selected))
        prepare_tiles(tiles_root, tiles_root, **options)
        found = True
    if not found:
        raise FileNotFoundError('No dataset in dist/data. Run configure_tiles.py --input "..." --copy '
                                'or add redandblack-pages. Use --frontend-only for a code-only update.')


def copy_site(source, destination, frontend_only=False):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError('Source and destination must be separate sibling directories.')
    for name in REQUIRED_FRONTEND:
        if not (source / name).is_file():
            raise FileNotFoundError(f'Missing frontend file: {source / name}')
    if not frontend_only:
        prepare_data(source)
    destination.mkdir(parents=True, exist_ok=True)
    for path in source.iterdir():
        if frontend_only and path.name == 'data':
            continue
        target = destination / path.name
        if path.is_dir():
            shutil.copytree(path, target, dirs_exist_ok=True)
        else:
            shutil.copy2(path, target)
    (destination / '.nojekyll').touch()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frontend-only', action='store_true')
    args = parser.parse_args()
    project = Path(__file__).resolve().parent
    source, destination = project / 'dist', project / 'docs'
    try:
        if not args.frontend_only:
            prepare_data(source)
        package_source(project)
        copy_site(source, destination, args.frontend_only)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f'Not prepared: {error}\n')
    print(f'Prepared: {destination}')
    print('Existing data was kept. Review changes before git add, commit and push.')


if __name__ == '__main__':
    main()
