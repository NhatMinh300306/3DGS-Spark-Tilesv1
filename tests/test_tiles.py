import json
import struct
import tempfile
import unittest
from pathlib import Path

from configure_tiles import REQUIRED, prepare_tiles, scan_tiles
from prepare_pages import REQUIRED_FRONTEND, copy_site


def ply(path, count=2):
    path.parent.mkdir(parents=True, exist_ok=True)
    properties = sorted(REQUIRED)
    header = 'ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % count
    header += ''.join('property float %s\n' % name for name in properties) + 'end_header\n'
    path.write_bytes(header.encode('ascii') + struct.pack('<%df' % (len(properties) * count),
                                                        *([0.] * (len(properties) * count))))
    return path


def dataset(root):
    for layer, count in [('layer_1', 4), ('layer_8', 2)]:
        for frame in [1450, 1451]:
            base = root / layer / f'frame_{frame}' / 'voxels_new'
            ply(base / 'x_1y_1z_1.ply', count)
            ply(base / 'x_2y_1z_1.ply', count)
            ply(base / 'x_3y_1z_1.ply', 0)


class TilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / 'Downloads' / 'redandblack_tiles' / 'redandblack_tiles'
        dataset(self.input)

    def test_copy_unwraps_windows_archive_folder_and_skips_zero_splats(self):
        output = self.root / 'dist' / 'data' / 'redandblack_tiles'
        unrelated = self.input / 'layer_1' / 'frame_1450' / 'do-not-copy.txt'
        unrelated.write_text('not a tile')
        manifest_path, manifest = prepare_tiles(self.input.parent, output, copy=True)
        self.assertEqual(json.loads(manifest_path.read_text()), manifest)
        self.assertEqual(manifest['defaultLayer'], 'layer_8')
        self.assertEqual(len(manifest['layers']), 2)
        self.assertEqual(len(manifest['layers'][0]['frames']), 2)
        for layer in manifest['layers']:
            for frame in layer['frames']:
                self.assertEqual(len(frame['tiles']), 2)
                self.assertEqual(frame['emptyTiles'], 1)
                for tile in frame['tiles']:
                    self.assertEqual((output / tile['path']).read_bytes(), (self.input / tile['path']).read_bytes())
                    self.assertEqual((output / tile['path']).stat().st_size, tile['bytes'])
        self.assertEqual(len(list(output.rglob('*.ply'))), 12)
        self.assertFalse(list(output.rglob('do-not-copy.txt')))

    def test_in_place_nested_root_keeps_valid_manifest_paths(self):
        output, manifest = prepare_tiles(self.input.parent, self.input.parent)
        self.assertEqual(output.parent, self.input.parent)
        path = manifest['layers'][0]['frames'][0]['tiles'][0]['path']
        self.assertTrue(path.startswith('redandblack_tiles/layer_1/'))
        self.assertTrue((output.parent / path).is_file())

    def test_frames_must_align_between_resolution_choices(self):
        frame = self.input / 'layer_8' / 'frame_1451'
        frame.rename(frame.with_name('frame_1452'))
        with self.assertRaisesRegex(ValueError, 'Frame list differs'):
            scan_tiles(self.input)
        _, manifest = scan_tiles(self.input, start=1450, end=1450)
        self.assertEqual(len(manifest['layers'][0]['frames']), 1)

    def test_missing_gaussian_attributes_and_truncated_payload_stop_before_copy(self):
        tile = self.input / 'layer_1' / 'frame_1450' / 'voxels_new' / 'bad.ply'
        tile.write_bytes(b'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n')
        target = self.root / 'output'
        with self.assertRaisesRegex(ValueError, 'Gaussian attributes'):
            prepare_tiles(self.input, target, copy=True)
        self.assertFalse(target.exists())
        ply(tile)
        tile.write_bytes(tile.read_bytes()[:-4])
        with self.assertRaisesRegex(ValueError, 'Truncated'):
            scan_tiles(self.input)

    def test_only_tiled_dataset_can_be_prepared_for_pages(self):
        source, target = self.root / 'dist', self.root / 'docs'
        prepare_tiles(self.input, source / 'data' / 'redandblack_tiles', copy=True,
                      default_layer='layer_1', fps=24, rotation=-90)
        for name in REQUIRED_FRONTEND:
            (source / name).write_text('fixture')
        copy_site(source, target)
        manifest = json.loads((target / 'data' / 'redandblack_tiles' / 'tiles.json').read_text())
        self.assertEqual(len(list(target.rglob('*.ply'))), 12)
        self.assertTrue((target / 'tiles.js').is_file())
        self.assertTrue((target / '.nojekyll').is_file())
        self.assertEqual(manifest['defaultLayer'], 'layer_1')
        self.assertEqual(manifest['fps'], 24)
        self.assertEqual(manifest['rotationX'], -90)

    def test_external_input_requires_explicit_copy_and_cannot_overlap(self):
        with self.assertRaisesRegex(ValueError, '--copy'):
            prepare_tiles(self.input, self.root / 'other')
        with self.assertRaisesRegex(ValueError, 'contain each other'):
            prepare_tiles(self.input, self.input / 'dist', copy=True)


if __name__ == '__main__':
    unittest.main()
