#!/usr/bin/env python3
"""Index layer_N/frame_N/voxels_new/*.ply as resolutions, frames and spatial tiles.

CMD: py configure_tiles.py --input "D:\\Downloads\\redandblack_tiles" --copy
Or put the dataset in dist/data/redandblack_tiles, then: py configure_tiles.py
No dependencies beyond Python. Never merges, quantizes or changes PLY contents.
"""
import argparse
import json
import re
import shutil
from pathlib import Path

SCHEMA = 'splat-lab-tiles-v1'
LAYER_RE = re.compile(r'layer_\d+$', re.I)
FRAME_RE = re.compile(r'frame_(\d+)$', re.I)
REQUIRED = {'x', 'y', 'z', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2',
            'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'}
SIZES = {'char': 1, 'uchar': 1, 'int8': 1, 'uint8': 1, 'short': 2, 'ushort': 2,
         'int16': 2, 'uint16': 2, 'int': 4, 'uint': 4, 'int32': 4, 'uint32': 4,
         'float': 4, 'float32': 4, 'double': 8, 'float64': 8}


def natural_key(name):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r'(\d+)', name)]


def find_root(path):
    path = Path(path).resolve()
    if not path.is_dir():
        raise FileNotFoundError(f'Dataset directory does not exist: {path}')
    # Windows extraction can add an extra redandblack_tiles wrapper directory.
    for _ in range(4):
        children = [p for p in path.iterdir() if p.is_dir()]
        if any(LAYER_RE.fullmatch(p.name) for p in children):
            return path
        if len(children) != 1:
            break
        path = children[0]
    raise ValueError(f'No layer_N folders found under {path}. Select the extracted dataset root.')


def read_ply_info(path):
    """Read only the header; validate Gaussian schema and binary payload length."""
    with path.open('rb') as stream:
        if stream.readline(64).strip() != b'ply':
            raise ValueError(f'Not a PLY: {path}')
        count, fmt, element, vertex_first = None, None, None, True
        properties, stride = set(), 0
        for _ in range(8192):
            line = stream.readline(8192)
            if not line or stream.tell() > 1048576:
                raise ValueError(f'Invalid/oversized PLY header: {path}')
            words = line.decode('ascii').strip().split()
            if not words:
                continue
            if words[0] == 'end_header':
                break
            if words[0] == 'format':
                fmt = words[1]
            elif words[0] == 'element':
                element = words[1]
                if element == 'vertex':
                    if count is not None or not vertex_first:
                        raise ValueError(f'Vertex must be the first PLY element: {path}')
                    count = int(words[2])
                elif count is None and int(words[2]) > 0:
                    vertex_first = False
            elif words[0] == 'property' and element == 'vertex':
                if len(words) != 3 or words[1] not in SIZES:
                    raise ValueError(f'Unsupported vertex property: {path}: {line!r}')
                if words[2] in properties:
                    raise ValueError(f'Duplicate PLY property: {path}: {words[2]}')
                properties.add(words[2])
                stride += SIZES[words[1]]
        else:
            raise ValueError(f'PLY header is too long: {path}')
        if fmt not in ('binary_little_endian', 'ascii') or count is None or count < 0:
            raise ValueError(f'Expected ASCII/binary little-endian PLY with vertex count: {path}')
        if count and REQUIRED - properties:
            raise ValueError(f'PLY lacks Gaussian attributes {sorted(REQUIRED - properties)}: {path}')
        size = path.stat().st_size
        if fmt == 'binary_little_endian' and size < stream.tell() + count * stride:
            raise ValueError(f'Truncated binary PLY: {path}')
        if count and size <= stream.tell():
            raise ValueError(f'Missing PLY vertex data: {path}')
    return {'splats': count, 'bytes': size}


def scan_tiles(root, start=None, end=None, default_layer=None, fps=30, rotation=0):
    root = find_root(root)
    layers = []
    for folder in sorted(root.iterdir(), key=lambda p: natural_key(p.name)):
        if not folder.is_dir() or not LAYER_RE.fullmatch(folder.name):
            continue
        frames, ids = [], set()
        for frame_dir in sorted(folder.iterdir(), key=lambda p: natural_key(p.name)):
            match = FRAME_RE.fullmatch(frame_dir.name)
            if not frame_dir.is_dir() or not match:
                continue
            frame_id = int(match[1])
            if (start is not None and frame_id < start) or (end is not None and frame_id > end):
                continue
            if frame_id in ids:
                raise ValueError(f'Duplicate frame number {frame_id} in {folder}')
            ids.add(frame_id)
            tile_dir = frame_dir / 'voxels_new'
            if not tile_dir.is_dir():
                raise FileNotFoundError(f'Missing tile directory: {tile_dir}')
            files = sorted((p for p in tile_dir.iterdir() if p.is_file() and p.suffix.lower() == '.ply'),
                           key=lambda p: natural_key(p.name))
            if not files:
                raise FileNotFoundError(f'No PLY files in {tile_dir}')
            tiles, empty = [], 0
            for path in files:
                if not path.resolve().is_relative_to(root):
                    raise ValueError(f'Tile path escapes the dataset: {path}')
                info = read_ply_info(path)
                if info['splats'] == 0:
                    empty += 1
                    continue
                tiles.append({'path': path.relative_to(root).as_posix(), **info})
            frames.append({'id': frame_id, 'tiles': tiles, 'emptyTiles': empty,
                           'totalBytes': sum(t['bytes'] for t in tiles),
                           'totalSplats': sum(t['splats'] for t in tiles)})
        if not frames:
            raise ValueError(f'No selected frame_N directories in {folder}')
        layers.append({'id': folder.name, 'label': folder.name + ' · resolution', 'frames': frames})
    if not layers:
        raise ValueError(f'No layers found in {root}')
    reference = [f['id'] for f in layers[0]['frames']]
    for layer in layers[1:]:
        actual = [f['id'] for f in layer['frames']]
        if actual != reference:
            raise ValueError(f'Frame list differs in {layer["id"]}; missing={sorted(set(reference)-set(actual))}, '
                             f'extra={sorted(set(actual)-set(reference))}. Use --start/--end for a common range.')
    # The folder number does NOT imply its byte size or image dimensions.
    lightest = min(layers, key=lambda layer: sum(f['totalBytes'] for f in layer['frames']))['id']
    selected = default_layer or lightest
    if selected not in [layer['id'] for layer in layers]:
        raise ValueError(f'Default layer not present: {selected}')
    return root, {'schema': SCHEMA, 'coordinateSpace': 'world', 'name': 'Redandblack · PLY tiles',
                  'defaultLayer': selected, 'fps': fps, 'rotationX': rotation, 'layers': layers}


def write_manifest(root, manifest):
    output = Path(root) / 'tiles.json'
    temp = output.with_suffix('.json.tmp')
    temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(output)
    return output


def prepare_tiles(source, destination, copy=False, **options):
    root, manifest = scan_tiles(source, **options)
    destination = Path(destination).resolve()
    if root != destination and Path(source).resolve() == destination:
        prefix = root.relative_to(destination).as_posix()
        for layer in manifest['layers']:
            for frame in layer['frames']:
                for tile in frame['tiles']:
                    tile['path'] = prefix + '/' + tile['path']
        return write_manifest(destination, manifest), manifest
    if root != destination:
        if not copy:
            raise ValueError('External input requires --copy to serve the tiles under dist/data. '
                             'Or use --output equal to --input when indexing a separate HTTP dataset.')
        if root in destination.parents or destination in root.parents:
            raise ValueError('Input and output cannot contain each other.')
        # Preserve the hierarchy, including empty PLY placeholders, without copying unrelated files.
        for layer in manifest['layers']:
            selected = {frame['id'] for frame in layer['frames']}
            for directory in (root / layer['id']).iterdir():
                match = FRAME_RE.fullmatch(directory.name)
                if not directory.is_dir() or not match or int(match[1]) not in selected:
                    continue
                target = destination / layer['id'] / directory.name / 'voxels_new'
                target.mkdir(parents=True, exist_ok=True)
                for path in (directory / 'voxels_new').iterdir():
                    if path.is_file() and path.suffix.lower() == '.ply':
                        shutil.copy2(path, target / path.name)
    return write_manifest(destination, manifest), manifest


def main():
    default = Path(__file__).resolve().parent / 'dist' / 'data' / 'redandblack_tiles'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', default=str(default))
    parser.add_argument('--output', default=str(default))
    parser.add_argument('--copy', action='store_true')
    parser.add_argument('--start', type=int)
    parser.add_argument('--end', type=int)
    parser.add_argument('--default-layer')
    parser.add_argument('--fps', type=int, default=30, choices=range(1, 61), metavar='1..60')
    parser.add_argument('--rotation', type=float, default=0)
    args = parser.parse_args()
    try:
        output, manifest = prepare_tiles(args.input, args.output, copy=args.copy,
            start=args.start, end=args.end, default_layer=args.default_layer,
            fps=args.fps, rotation=args.rotation)
    except (OSError, ValueError, IndexError, UnicodeError) as error:
        parser.exit(1, f'Not configured: {error}\n')
    for layer in manifest['layers']:
        frames = layer['frames']
        print(f'{layer["id"]}: {len(frames)} frames, '
              f'{sum(len(f["tiles"]) for f in frames)} nonempty tiles, '
              f'{sum(f["emptyTiles"] for f in frames)} empty tiles skipped')
    reason = 'selected by --default-layer' if args.default_layer else 'smallest dataset by bytes'
    print(f'Default resolution: {manifest["defaultLayer"]} ({reason})')
    print(f'Created: {output}')
    print('Run the local server and select Redandblack - PLY tiles. PLY contents were not changed.')


if __name__ == '__main__':
    main()
