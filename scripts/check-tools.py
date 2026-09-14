#!/usr/bin/env python3
"""Smoke-test the native lab and lifetime measurement clients with synthetic data."""
import base64, json, os, pathlib, shutil, socket, subprocess, tempfile, time, urllib.request, urllib.error, uuid
root = pathlib.Path(__file__).resolve().parent.parent
build = root.parent / 'build'
(build / 'tmp').mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='lab-smoke-', dir=build / 'tmp') as name:
    d = pathlib.Path(name)
    fixtures = d / 'fixtures'
    bundle = d / 'bundle'
    (bundle / 'dist').mkdir(parents=True)
    (bundle / 'dist' / 'index.html').write_text('<!doctype html><title>Native lab fixture</title>')
    (bundle / 'build.json').write_text(json.dumps({'schema': 1, 'sha256': 'test-build'}))
    results = []
    for scenario in ['fresh', 'aged', 'archive', 'live', 'both']:
        (fixtures / scenario / 'history').mkdir(parents=True)
        shutil.copy(root / 'server-rust/tests/fixtures/browser-owner.yjs', fixtures / (scenario + '.yjs'))
        results.append({'scenario': scenario})
    (fixtures / 'manifest.json').write_text(json.dumps({'schema': 2, 'currentSchema': 'stow-current-v1', 'blobs': [], 'results': results}))
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://localhost:{port}'
    run = str(uuid.uuid4())
    report_id = str(uuid.uuid4())
    files = []
    env = {**os.environ, 'TMPDIR': str(build / 'tmp')}
    p = subprocess.Popen([str(build / 'cargo-target/debug/stow-test-driver'), 'lab', '--local-test', f'--port={port}', f'--origin={origin}', f'--bundle-dir={bundle}', f'--fixtures-dir={fixtures}'], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def req(path, method='GET', body=None, headers=None):
        h = {'Cookie': 'stow_lab_user=first%40example.test', **(headers or {})}
        data = None if body is None else json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
        r = urllib.request.Request(origin + path, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(r, timeout=10) as out:
                return (out.status, out.read())
        except urllib.error.HTTPError as e:
            return (e.code, e.read())
    prefix = f'/storage-lab/aged/{run}'
    try:
        for _ in range(200):
            try:
                status, data = req(prefix + '/api/session')
                break
            except (OSError, urllib.error.URLError):
                if p.poll() is not None:
                    raise RuntimeError(p.stderr.read())
                time.sleep(0.05)
        else:
            raise RuntimeError('Laboratory did not become ready within ten seconds')
        assert status == 200, (status, data)
        a = json.loads(data)['vaultId']
        h = {'X-Stow-Vault': a}
        status, data = req(prefix + '/api/storage', headers=h)
        assert status == 200
        storage = json.loads(data)
        assert storage['retention']['enabled'] == False
        assert storage['compression']['enabled'] == False
        status, data = req(prefix + '/api/session', headers={'Cookie': 'stow_lab_user=second%40example.test'})
        b = json.loads(data)['vaultId']
        assert a != b
        assert req(prefix + '/api/storage', headers={'Cookie': 'stow_lab_user=second%40example.test', 'X-Stow-Vault': a})[0] == 409
        assert req(prefix + '/api/session', headers={'Cookie': ''})[0] == 403
        assert req('/storage-lab-suffix/aged/' + run + '/api/session')[0] == 403
        status, data = req(prefix + '/api/lab/manifest')
        assert status == 200
        assert json.loads(data)['runId'] == run
        report = {'schema': 1, 'id': report_id, 'scenario': 'aged', 'runId': run, 'startedAt': 1000, 'samples': [{'name': 'startup-ready', 'startMs': 0, 'durationMs': 1, 'count': 0}], 'privateText': 'must disappear'}
        assert req(prefix + '/api/lab/report', 'POST', report, {'X-Stow-Vault': b})[0] == 409
        for _ in range(2):
            status, data = req(prefix + '/api/lab/report', 'POST', report, h)
            assert status == 201, (status, data)
            assert json.loads(data)['savedStages'] == 1
        files.append(build / 'storage-lab/reports' / f'{a}-{report_id}.json')
        saved = json.loads(req(prefix + '/api/lab/reports', headers=h)[1])['reports']
        assert len(saved) == 1
        assert 'privateText' not in saved[0]
        assert saved[0]['startup'] == {'reports': []}
        bad = {**report, 'samples': [{'name': 'private note text', 'startMs': 0, 'durationMs': 1}]}
        assert req(prefix + '/api/lab/report', 'POST', bad, h)[0] == 400
        with socket.create_connection(('127.0.0.1', port), timeout=10) as ws:
            ws.sendall(f'GET {prefix}/sync?schema=stow-current-v1&protocol=2&vaultId={a} HTTP/1.1\r\nHost: localhost:{port}\r\nCookie: stow_lab_user=first%40example.test\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\nSec-WebSocket-Version: 13\r\n\r\n'.encode())
            response = ws.recv(4096)
            assert response.startswith(b'HTTP/1.1 101'), response
        print('Native lab smoke passed: isolated seeded accounts, preferences, authentication, binding, reports, diagnostics, duplicate stages, and WebSocket upgrade.')
    finally:
        p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            raise
        for path in files:
            path.unlink(missing_ok=True)
with tempfile.TemporaryDirectory(prefix='lifetime-smoke-', dir=build / 'tmp') as name:
    output = pathlib.Path(name) / 'result'
    subprocess.run(['node', '--import', 'tsx', 'scripts/experiment-storage-lifetime.ts', '--max-actions', '101', '--output', str(output)], cwd=root, check=True)
    report = json.loads((output / 'measurements.json').read_text())
    assert report['growth'][0]['retained'] == 75, 'Compression must retain 75 endpoints after 101 actions'
    drafts = report['drafts']
    assert len(drafts) == 6
    assert len({row['pendingBytes']['max'] for row in drafts}) == 1, 'Recovery payload must not grow with checklist size'
    assert drafts[0]['pendingBytes']['max'] < 128, 'Recovery must contain timestamps only'
    print('Lifetime smoke passed: bounded endpoints, standalone previews, and constant-size recovery timestamps.')
