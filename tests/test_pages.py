import json
import struct
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from configure_dataset import scan_dataset, validate_rad, write_index
from prepare_pages import copy_site, REQUIRED_FRONTEND
from serve import Handler


def rad_fixture(path, chunked=True):
    """A header/chunk boundary fixture, NOT a decodable Gaussian scene."""
    path.parent.mkdir(parents=True, exist_ok=True)
    chunk = b'RADC' + b'\0' * 12
    filename = path.stem + '-0.radc'
    metadata = {'version': 1, 'type': 'gsplat', 'lodTree': True, 'count': 1,
                'chunks': [{'offset': 0, 'bytes': len(chunk)}]}
    if chunked:
        metadata['chunks'][0]['filename'] = filename
    encoded = json.dumps(metadata).encode()
    header = b'RAD0' + struct.pack('<I', len(encoded)) + encoded
    header += b'\0' * ((-len(header)) % 8)
    path.write_bytes(header if chunked else header + chunk)
    if chunked:
        (path.parent / filename).write_bytes(chunk)


class PagesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'dist'
        self.dest = Path(self.temp.name) / 'docs'
        self.source.mkdir()
        for name in REQUIRED_FRONTEND:
            (self.source / name).write_text('fixture ' + name)

    def test_missing_data_stops_before_copy(self):
        with self.assertRaises(FileNotFoundError):
            copy_site(self.source, self.dest)
        self.assertFalse(self.dest.exists())

    def test_ply_data_and_code_are_copied_without_deleting_other_files(self):
        for res in ('res1', 'res2', 'res4', 'res8'):
            for frame in range(1450, 1480):
                path = self.source / 'data' / 'redandblack-pages' / res / f'{frame:06d}.ply'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'fixture')
        self.dest.mkdir()
        (self.dest / 'keep.txt').write_text('keep')
        copy_site(self.source, self.dest)
        self.assertEqual(len(scan_dataset(self.dest)['sequences']['ply']['framesByResolution']['res8']), 30)
        self.assertTrue((self.dest / 'ui.js').is_file())
        self.assertTrue((self.dest / '.nojekyll').is_file())
        self.assertEqual((self.dest / 'keep.txt').read_text(), 'keep')

    def test_rad_only_dataset_includes_chunks_and_exact_filenames(self):
        for resolution in ('res4', 'res8'):
            for frame in (1450, 1451):
                rad_fixture(self.source / 'data' / 'redandblack-pages' / resolution / f'{frame:06d}.rad')
        copy_site(self.source, self.dest)
        index = json.loads((self.dest / 'data' / 'redandblack-scenes.json').read_text())
        self.assertEqual(index['sequences']['rad']['resolutions'], ['res4', 'res8'])
        self.assertEqual(index['sequences']['rad']['framesByResolution']['res8'], ['001450.rad', '001451.rad'])
        self.assertEqual(len(list(self.dest.rglob('*.radc'))), 4)

    def test_missing_or_truncated_chunk_stops_publish(self):
        rad = self.source / 'data' / 'redandblack-pages' / 'res8' / '001450-lod.rad'
        rad_fixture(rad)
        chunk = rad.with_name('001450-lod-0.radc')
        chunk.unlink()
        with self.assertRaisesRegex(FileNotFoundError, 'Missing RADC'):
            copy_site(self.source, self.dest)
        self.assertFalse(self.dest.exists())
        chunk.write_bytes(b'RADC')
        with self.assertRaisesRegex(ValueError, 'Truncated'):
            validate_rad(rad)

    def test_monolithic_rad_and_resolution_mismatch(self):
        root = self.source / 'data' / 'redandblack-pages'
        rad_fixture(root / 'res8' / '001450-lod.rad', chunked=False)
        self.assertIn('rad', scan_dataset(self.source)['sequences'])
        rad_fixture(root / 'res1' / '001451-lod.rad', chunked=False)
        with self.assertRaisesRegex(ValueError, 'frame list differs'):
            scan_dataset(self.source)

    def test_frontend_only_preserves_existing_dataset_and_index(self):
        data = self.dest / 'data'
        data.mkdir(parents=True)
        (data / 'old.rad').write_bytes(b'old')
        (data / 'redandblack-scenes.json').write_text('existing')
        copy_site(self.source, self.dest, frontend_only=True)
        self.assertEqual((data / 'old.rad').read_bytes(), b'old')
        self.assertEqual((data / 'redandblack-scenes.json').read_text(), 'existing')
        self.assertTrue((self.dest / 'app.js').is_file())

    def test_rejects_overlapping_source_and_destination(self):
        with self.assertRaises(ValueError):
            copy_site(self.source, self.source / 'docs', True)

    def test_local_http_server_returns_actual_ranges_for_monolithic_rad(self):
        rad = self.source / 'frame.rad'
        rad_fixture(rad, chunked=False)
        payload = rad.read_bytes()
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(self.source)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/frame.rad',
                                             headers={'Range': 'bytes=8-19'})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers['Content-Range'], f'bytes 8-19/{len(payload)}')
                self.assertEqual(response.read(), payload[8:20])
                self.assertEqual(response.headers['Access-Control-Allow-Origin'], '*')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
