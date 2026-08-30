"""GROMa's dependency-free remote operations helper. Runs over SSH; never installs a daemon."""
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=180, check=False)
    if result.returncode:
        # Compose errors may echo environment values. Keep raw output out of the public error contract.
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed (exit {result.returncode}); inspect the host directly")
    return result.stdout


def objects(text):
    if not text.strip():
        return []
    if text.lstrip().startswith('['):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


class Agent:
    def __init__(self, root='/opt/groma'):
        self.root = Path(root)

    @contextlib.contextmanager
    def locked(self):
        if not self.root.is_dir() or self.root.is_symlink():
            raise RuntimeError('GROMa host directory is missing or unsafe')
        lock_path = self.root / '.deploy.lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + 120
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Timed out waiting for the deployment lock')
                    time.sleep(0.1)
            yield
        finally:
            os.close(fd)

    def project(self, name):
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,60}', name):
            raise ValueError('Invalid project name')
        directory = self.root / name
        if directory.is_symlink():
            raise RuntimeError('Project directory must not be a symlink')
        return directory

    def release(self, directory, pointer='current', required=True):
        link = directory / pointer
        if not link.is_symlink():
            if required or link.exists():
                raise RuntimeError(f'Missing or unsafe {pointer} release')
            return None
        release = link.resolve(strict=True)
        releases = directory / 'releases'
        if releases.is_symlink() or release.parent != releases.resolve() or not release.is_dir():
            raise RuntimeError('Release pointer escapes the project releases directory')
        if not (release / 'compose.yaml').is_file() or (release / 'compose.yaml').is_symlink():
            raise RuntimeError('Missing or unsafe release manifest')
        return release

    def identity(self, release, expected):
        if (release / 'identity').read_text() != expected:
            raise RuntimeError('Project identity does not match this configuration')

    def compose(self, name, release, args):
        command = ['docker', 'compose', '--project-name', name, '--project-directory', str(release), '-f', str(release / 'compose.yaml')]
        if (release / 'images.lock.yaml').is_file():
            command += ['-f', str(release / 'images.lock.yaml')]
        return run(command + args)

    def inspect(self, name):
        ids = run(['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={name}']).split()
        return json.loads(run(['docker', 'inspect'] + ids)) if ids else []

    def active(self, request):
        directory = self.project(request['project'])
        release = self.release(directory)
        self.identity(release, request['identity'])
        config = json.loads((release / 'project.json').read_text()) if (release / 'project.json').is_file() else None
        return {'release': release.name, 'config': config}

    def snapshot(self, request):
        name = request['project']
        directory = self.project(name)
        current = self.release(directory, required=False)
        if current:
            self.identity(current, request['identity'])
        previous_config = json.loads(self.compose(name, current, ['config', '--format', 'json'])) if current else None
        # Resolution consults the registry, but does not pull images, create containers, or alter releases.
        with tempfile.TemporaryDirectory(prefix='groma-plan-') as temp:
            candidate = Path(temp)
            (candidate / 'compose.yaml').write_text(request['compose'])
            lock = self.compose(name, candidate, ['config', '--lock-image-digests'])
            if not lock.strip():
                raise RuntimeError('Image digest resolution returned no data')
            (candidate / 'images.lock.yaml').write_text(lock)
            desired = json.loads(self.compose(name, candidate, ['config', '--format', 'json']))
        return {
            'currentRelease': current.name if current else None,
            'current': previous_config,
            'candidate': desired,
            'imageLock': lock,
            'currentRoutes': (current / 'route.caddy').read_text() if current else '',
            'candidateRoutes': request['routes'],
        }

    def apps(self):
        result = []
        for directory in sorted(self.root.iterdir()):
            if not re.fullmatch(r'[a-z][a-z0-9-]{0,60}', directory.name):
                continue
            if not directory.is_dir() or directory.is_symlink():
                continue
            try:
                current = self.release(directory, required=False)
                if not current:
                    continue
                containers = self.inspect(directory.name)
                running_ids = [c['Id'] for c in containers if c.get('State', {}).get('Running')]
                stats = objects(run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'] + running_ids)) if running_ids else []
                by_id = {s['ID']: s for s in stats}
                services = []
                for container in containers:
                    state = container.get('State', {})
                    label = container.get('Config', {}).get('Labels') or {}
                    stat = next((v for k, v in by_id.items() if container['Id'].startswith(k)), {})
                    services.append({
                        'name': label.get('com.docker.compose.service', 'unknown'),
                        'image': container.get('Config', {}).get('Image'),
                        'state': state.get('Status', 'unknown'),
                        'health': state.get('Health', {}).get('Status', 'not-configured'),
                        'cpu': stat.get('CPUPerc'), 'memory': stat.get('MemUsage'),
                    })
                routes = (current / 'routes.tsv').read_text().splitlines()
                result.append({'project': directory.name, 'release': current.name,
                               'urls': ['https://' + row.split()[0] for row in routes if len(row.split()) == 2],
                               'services': services})
            except (OSError, ValueError, RuntimeError) as error:
                result.append({'project': directory.name, 'error': str(error)})
        memory = {}
        with open('/proc/meminfo') as handle:
            for line in handle:
                key, value = line.split(':', 1)
                if key in ('MemTotal', 'MemAvailable'):
                    memory[key] = int(value.split()[0]) * 1024
        disk = shutil.disk_usage(self.root)
        return {'apps': result, 'observedAt': time.time(),
                'host': {'cpus': os.cpu_count(), 'loadAverage': os.getloadavg(), 'memoryBytes': memory,
                         'diskBytes': {'total': disk.total, 'used': disk.used, 'free': disk.free}}}

    def lifecycle(self, request, action):
        name = request['project']
        current = self.release(self.project(name))
        self.identity(current, request['identity'])
        if action == 'stop':
            config = json.loads(self.compose(name, current, ['config', '--format', 'json']))
            if any(service.get('tmpfs') for service in config.get('services', {}).values()) and not request.get('allowEphemeralLoss', False):
                raise RuntimeError('Stopping loses ephemeral tmpfs data; pass --allow-ephemeral-loss explicitly')
            self.compose(name, current, ['stop', '--timeout', '30'])
        else:
            # Start existing containers only: no pulls, recreation, migrations, or config changes.
            config = json.loads(self.compose(name, current, ['config', '--format', 'json']))
            services = {c.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') for c in self.inspect(name)}
            if not set(config['services']).issubset(services):
                raise RuntimeError('Some containers are missing; use deploy to recreate them')
            self.compose(name, current, ['up', '-d', '--no-recreate', '--wait', '--wait-timeout', '120'])
        return {'project': name, 'release': current.name, 'action': action,
                'containers': objects(self.compose(name, current, ['ps', '--all', '--format', 'json']))}

    def prune(self, request):
        name = request['project']
        keep = request.get('keep', 5)
        age = request.get('minAgeHours', 24)
        if type(keep) is not int or keep < 2 or keep > 1000 or type(age) not in (int, float) or age < 0 or age > 87600:
            raise ValueError('keep must be 2–1000; minAgeHours must be 0–87600')
        directory = self.project(name)
        current = self.release(directory)
        self.identity(current, request['identity'])
        previous = self.release(directory, 'previous', required=False)
        protected = {current}
        if previous:
            protected.add(previous)
        for container in self.inspect(name):
            working = (container.get('Config', {}).get('Labels') or {}).get('com.docker.compose.project.working_dir')
            if working:
                protected.add(Path(working).resolve())
        valid = []
        skipped = []
        for release in (directory / 'releases').iterdir():
            if release.is_symlink() or not release.is_dir() or not re.fullmatch(r'[A-Za-z0-9-]+', release.name):
                skipped.append(release.name)
                continue
            try:
                if any(p.is_symlink() for p in release.rglob('*')):
                    raise ValueError('Symlink in release')
                self.identity(release, request['identity'])
                metadata = json.loads((release / 'release.json').read_text())
                if metadata['project'] != name or metadata['release'] != release.name:
                    raise ValueError('Release metadata mismatch')
                valid.append(release)
            except (OSError, ValueError, KeyError, RuntimeError):
                skipped.append(release.name)
        valid.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        preserve = protected | set(valid[:keep])
        cutoff = time.time() - age * 3600
        candidates = [p for p in valid if p not in preserve and p.stat().st_mtime <= cutoff]
        report = {'project': name, 'dryRun': not request.get('execute', False),
                  'releases': [p.name for p in candidates], 'protected': sorted(p.name for p in preserve),
                  'skipped': skipped, 'bytes': sum(f.stat().st_size for p in candidates for f in p.rglob('*') if f.is_file())}
        if request.get('execute', False):
            for release in candidates:
                shutil.rmtree(release)
        return report

    def dispatch(self, action, request):
        with self.locked():
            if action == 'apps': return self.apps()
            if action == 'snapshot': return self.snapshot(request)
            if action == 'active': return self.active(request)
            if action in ('start', 'stop'): return self.lifecycle(request, action)
            if action == 'prune': return self.prune(request)
            raise ValueError('Unknown operation')


if __name__ == '__main__':
    try:
        request = json.loads(base64.b64decode(sys.argv[2], validate=True))
        print(json.dumps(Agent().dispatch(sys.argv[1], request)))
    except Exception as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
