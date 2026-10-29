#!/usr/bin/env python3
"""Index local PLY/RAD sequences and check every RAD chunk before publishing.

CMD: py configure_dataset.py
Only writes dist/data/redandblack-scenes.json. Never changes the data files.
RAD header layout: Spark v2.3.1, rust/spark-lib/src/rad.rs (RAD0 + u32 JSON length).
"""
import argparse
import json
import re
import struct
from pathlib import Path

RESOLUTIONS = ('res1', 'res2', 'res4', 'res8')
INDEX_NAME = 'redandblack-scenes.json'


def natural_key(name):
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r'(\d+)', name)]


def validate_rad(path):
    """Check metadata, file boundaries, and referenced chunks; not a decode test."""
    with path.open('rb') as stream:
        prefix = stream.read(8)
        if len(prefix) != 8 or prefix[:4] != b'RAD0':
            raise ValueError(f'Invalid RAD header: {path}')
        length = struct.unpack('<I', prefix[4:])[0]
        if not 0 < length <= 1048576 - 8:
            raise ValueError(f'RAD header exceeds viewer limit: {path}')
        meta = json.loads(stream.read(length))
    if not meta.get('lodTree') or not meta.get('count') or not meta.get('chunks'):
        raise ValueError(f'RAD has no LoD tree/chunks: {path}')
    chunks_start = 8 + ((length + 7) // 8) * 8
    for chunk in meta['chunks']:
        filename = chunk.get('filename')
        size = chunk.get('bytes', 0)
        offset = chunk.get('offset', 0)
        if not isinstance(size, int) or size <= 0 or not isinstance(offset, int) or offset < 0:
            raise ValueError(f'Invalid chunk bounds: {path}')
        target = (path.parent / filename).resolve() if filename else path.resolve()
        if filename and not target.is_relative_to(path.parent.resolve()):
            raise ValueError(f'Chunk must be stored beneath its RAD folder: {filename}')
        if not target.is_file():
            raise FileNotFoundError(f'Missing RADC: {target} (referenced by {path.name})')
        start = 0 if filename else chunks_start + offset
        if target.stat().st_size < start + size:
            raise ValueError(f'Truncated RAD/RADC: {target}')
        with target.open('rb') as stream:
            stream.seek(start)
            if stream.read(4) != b'RADC':
                raise ValueError(f'Invalid chunk magic: {target}')
    return meta


def scan_dataset(source):
    source = Path(source)
    dataset = source / 'data' / 'redandblack-pages'
    sequences = {}
    for format_name in ('rad', 'ply'):
        groups = {}
        for resolution in RESOLUTIONS:
            folder = dataset / resolution
            if not folder.is_dir():
                continue
            files = sorted((p for p in folder.iterdir()
                            if p.is_file() and p.suffix.lower() == '.' + format_name),
                           key=lambda path: natural_key(path.name))
            if not files:
                continue
            for path in files:
                if format_name == 'rad':
                    validate_rad(path)
                elif path.stat().st_size == 0:
                    raise ValueError(f'Empty PLY: {path}')
            groups[resolution] = [p.name for p in files]
        if not groups:
            continue
        reference = next(iter(groups.values()))
        for resolution, names in groups.items():
            if names != reference:
                raise ValueError(f'{format_name.upper()} frame list differs in {resolution}; '
                                 'each resolution must contain the same frame names.')
        sequences[format_name] = {
            'baseUrl': './data/redandblack-pages/',
            'format': format_name,
            'resolutions': list(groups),
            'defaultResolution': 'res8' if 'res8' in groups else next(reversed(groups)),
            'framesByResolution': groups,
        }
    if not sequences:
        raise FileNotFoundError(f'No RAD/PLY frames found under {dataset}/res1, res2, res4 or res8.')
    return {'version': 1, 'sequences': sequences}


def write_index(source, index):
    output = Path(source) / 'data' / INDEX_NAME
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', default=str(Path(__file__).resolve().parent / 'dist'))
    args = parser.parse_args()
    try:
        index = scan_dataset(args.directory)
        output = write_index(args.directory, index)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f'Not configured: {error}\n')
    for format_name, sequence in index['sequences'].items():
        for resolution, names in sequence['framesByResolution'].items():
            print(f'{format_name.upper()} {resolution}: {len(names)} frames ({names[0]} -> {names[-1]})')
    print(f'Created: {output}')
    print('Refresh the viewer with Ctrl+F5. Source data was not modified.')


if __name__ == '__main__':
    main()
