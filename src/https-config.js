const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');

function normalizeHost(value) {
  const host = String(value ?? '').trim().toLowerCase();
  // Old deployments used 0.0.0.0 as a certificate name instead of a listen address.
  if (['', 'auto', 'change_me', '0.0.0.0'].includes(host)) return null;
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number);
    if (first === 0 || first >= 224 || (first === 169 && second === 254)) {
      throw new Error('LABOS_HTTPS_HOST must identify an actual IPv4 address or hostname');
    }
    return host;
  }
  if (host.length <= 253 && /[a-z]/.test(host) && host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return host;
  throw new Error('LABOS_HTTPS_HOST must be auto, an IPv4 address or a hostname without a URL, port or path');
}

function selectHttpsHost(value, interfaces = {}, routeTable = '') {
  const explicit = normalizeHost(value);
  if (explicit) return { host: explicit, automatic: false, interface: null };
  const excluded = /^(?:lo\d*$|docker\d*$|br-|veth|virbr|cni|flannel|podman|tun\d*$|tap\d*$|wg\d*$|tailscale|zt|utun)/i;
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (excluded.test(name)) continue;
    for (const entry of addresses || []) {
      if (entry.internal || !['IPv4', 4].includes(entry.family) || isIP(entry.address) !== 4) continue;
      const [first, second] = entry.address.split('.').map(Number);
      if (first === 0 || first === 127 || first >= 224 || (first === 169 && second === 254)) continue;
      const privateAddress = first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
      if (!candidates.some(candidate => candidate.host === entry.address && candidate.interface === name)) {
        candidates.push({ host: entry.address, interface: name, privateAddress });
      }
    }
  }
  const defaults = String(routeTable).split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 8 && fields[1] === '00000000' && fields[7] === '00000000' &&
      /^[0-9a-f]+$/i.test(fields[3]) && (parseInt(fields[3], 16) & 1) && /^\d+$/.test(fields[6]) &&
      candidates.some(candidate => candidate.interface === fields[0]))
    .map(fields => ({ interface: fields[0], metric: Number(fields[6]) }));
  let eligible = candidates;
  if (defaults.length) {
    const metric = Math.min(...defaults.map(route => route.metric));
    const preferred = new Set(defaults.filter(route => route.metric === metric).map(route => route.interface));
    eligible = eligible.filter(candidate => preferred.has(candidate.interface));
  }
  if (eligible.some(candidate => candidate.privateAddress)) eligible = eligible.filter(candidate => candidate.privateAddress);
  eligible = eligible.filter((candidate, index) => eligible.findIndex(other => other.host === candidate.host) === index);
  if (eligible.length !== 1) {
    const detail = eligible.map(candidate => `${candidate.interface}=${candidate.host}`).join(', ') || 'none';
    throw new Error(`Cannot determine one HTTPS host IPv4 (${detail}); check host networking or set LABOS_HTTPS_HOST to the desired LAN IPv4 or hostname`);
  }
  return { host: eligible[0].host, automatic: true, interface: eligible[0].interface };
}

function caddyfileForHost(value) {
  const host = normalizeHost(value);
  if (!host) throw new Error('Caddy configuration requires a resolved HTTPS host');
  return `{
    admin off
    auto_https disable_redirects
    skip_install_trust
    default_sni ${host}
}
https://${host}:443 {
    tls internal
    reverse_proxy labos:3000
}
`;
}

function writeHttpsConfig(runtimeDir, content) {
  // shortcut: config's runtime parent is app-owned; isolate config if runtime writers become untrusted.
  const directory = path.join(runtimeDir, 'https-config');
  try {
    fs.mkdirSync(directory, { mode: 0o755 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let temporary, fileFd;
  try {
    const stat = fs.fstatSync(directoryFd);
    if (!stat.isDirectory() || stat.uid !== 0) throw new Error('HTTPS configuration directory must be owned by root and must not be a symlink');
    fs.fchmodSync(directoryFd, 0o755);
    // Linux init runs as root; anchor every file operation to the verified directory inode.
    const anchored = `/proc/self/fd/${directoryFd}`;
    const destination = `${anchored}/Caddyfile`;
    try {
      const current = fs.lstatSync(destination);
      if (!current.isFile() || current.uid !== 0) throw new Error('Existing HTTPS Caddyfile must be a regular root-owned file');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporaryPath = `${anchored}/.Caddyfile-${crypto.randomBytes(12).toString('hex')}`;
    fileFd = fs.openSync(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    temporary = temporaryPath;
    fs.fchmodSync(fileFd, 0o644);
    fs.writeFileSync(fileFd, content);
    fs.fsyncSync(fileFd);
    fs.closeSync(fileFd);
    fileFd = undefined;
    fs.renameSync(temporary, destination);
    temporary = undefined;
    fs.fsyncSync(directoryFd);
  } finally {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    try {
      if (temporary) fs.unlinkSync(temporary);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
  return path.join(directory, 'Caddyfile');
}

function prepareHttpsConfig({ runtimeDir = '/var/lib/labos', host = 'auto' } = {}) {
  let interfaces, routes = '';
  if (!normalizeHost(host)) {
    interfaces = os.networkInterfaces();
    try {
      routes = fs.readFileSync('/proc/net/route', 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const selected = selectHttpsHost(host, interfaces, routes);
  const configPath = writeHttpsConfig(runtimeDir, caddyfileForHost(selected.host));
  return { ...selected, configPath };
}

module.exports = { selectHttpsHost, caddyfileForHost, writeHttpsConfig, prepareHttpsConfig };
