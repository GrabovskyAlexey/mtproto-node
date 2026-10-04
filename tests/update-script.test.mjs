import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = readFileSync(new URL('../update.sh', import.meta.url), 'utf8').replaceAll('\r', '');
const bash = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test('installer and updater have valid Bash syntax', () => {
  for (const file of ['install.sh', 'update.sh']) {
    const result = spawnSync(bash, ['-n'], {
      input: readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  }
});

function run(failBuild = false, container = false) {
  const mocks = `
exec 3>&2
function [() {
  case "$*" in
    *"docker-compose.yml ]"|*".git ]"|*".env ]") if builtin [ "$1" = "!" ]; then return 1; else return 0; fi ;;
    *"/.dockerenv ]") return ${container ? '0' : '1'} ;;
  esac
  builtin [ "$@"
}
function git() {
  printf 'GIT %s\\n' "$*" >&3
  case "$*" in 'remote show origin') echo 'HEAD branch: master' ;; esac
}
function grep() {
  case "$*" in
    '^AUTH_TOKEN= .env') echo 'AUTH_TOKEN=test-token=tail' ;;
    '^PORT= .env') echo 'PORT=8999' ;;
    *) command grep "$@" ;;
  esac
}
function docker() {
  printf 'DOCKER %s\\n' "$*" >&3
  case "$1 $2" in
    'inspect mtproto-service-node') echo '/opt/mtproto-node' ;;
    'ps --format') printf 'mtproto-service-node\\nmtproto-proxy-active\\nmtproto-proxy-paused\\n' ;;
    'ps --filter') printf 'mtproto-service-node\\nmtproto-proxy-active\\n' ;;
    'compose pull') ${failBuild ? 'return 1' : 'return 0'} ;;
    'compose build') ${failBuild ? 'return 1' : 'return 0'} ;;
  esac
}
function curl() {
  printf 'CURL %s\\n' "$*" >&3
  case "\${!#}" in
    */api/health) return 0 ;;
    */api/proxies) echo '[{"id":"active"},{"id":"stopped"},{"id":"paused"}]' ;;
    */api/proxies/active) echo '{"status":"stopped"}' ;;
    */restart) printf '200' ;;
  esac
}
function sleep() { return 0; }
`;
  return spawnSync(bash, ['-s'], { input: `${mocks}\n${script}`, encoding: 'utf8' });
}

test('existing node migrates origin and reads custom port before readiness; only active proxies restore', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.indexOf('remote set-url origin https://github.com/GrabovskyAlexey/mtproto-node.git') < result.stderr.indexOf('fetch origin master'));
  assert.match(result.stderr, /http:\/\/localhost:8999\/api\/health/);
  assert.match(result.stderr, /Bearer test-token=tail/);
  assert.match(result.stderr, /\/api\/proxies\/active\/restart/);
  assert.doesNotMatch(result.stderr, /\/api\/proxies\/stopped/);
  assert.doesNotMatch(result.stderr, /\/api\/proxies\/paused/);
  assert.doesNotMatch(result.stderr, /compose down|GIT stash/);
});

test('failed pull and failed fallback build leave existing service running', () => {
  const result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DOCKER compose build/);
  assert.doesNotMatch(result.stderr, /compose down|compose up/);
});

test('API update detaches worker with host bind paths and host networking', () => {
  const result = run(false, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /DOCKER pull ghcr.io\/grabovskyalexey\/mtproto-node:latest/);
  assert.match(result.stderr, /DOCKER run -d --rm --name mtproto-node-updater --network host/);
  assert.match(result.stderr, /-v \/opt\/mtproto-node:\/opt\/mtproto-node -w \/opt\/mtproto-node -e UPDATE_WORKER=1/);
  assert.doesNotMatch(result.stderr, /compose up|GIT fetch/);
});
