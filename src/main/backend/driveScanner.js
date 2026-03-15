'use strict';

const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/**
 * Parse lsblk JSON output into structured drive list
 */
async function scanDrives() {
  // lsblk: list block devices as JSON with all needed fields
  const { stdout } = await execFileAsync('lsblk', [
    '--json',
    '-b',
    '--output',
    'NAME,PATH,SIZE,FSTYPE,MOUNTPOINT,MOUNTPOINTS,LABEL,UUID,MODEL,SERIAL,TYPE,ROTA,TRAN,VENDOR,HOTPLUG,RM,RO,PKNAME,PARTTYPE,PARTTYPENAME'
  ]);

  const data = JSON.parse(stdout);
  const devices = [];

  function processDevice(dev, parent) {
    const ownModel = (dev.model || '').trim() || (dev.vendor || '').trim() || null;
    const entry = {
      name: dev.name,
      path: dev.path || `/dev/${dev.name}`,
      size: parseInt(dev.size) || 0,
      sizeHuman: formatBytes(parseInt(dev.size) || 0),
      fstype: dev.fstype || null,
      mountpoint: dev.mountpoint || (dev.mountpoints && dev.mountpoints.find(m => m)) || null,
      mountpoints: dev.mountpoints || (dev.mountpoint ? [dev.mountpoint] : []),
      label: dev.label || null,
      uuid: dev.uuid || null,
      // own model (only populated on disk-level devices by lsblk)
      model: ownModel,
      // friendly name: own model, or inherited from parent disk
      friendlyName: ownModel || (parent ? (parent.friendlyName || parent.model) : null),
      serial: dev.serial || null,
      type: dev.type, // disk, part, rom, loop, etc.
      rotational: dev.rota,
      transport: dev.tran || null, // nvme, sata, usb, etc.
      hotplug: dev.hotplug || dev.rm || false,
      readonly: dev.ro || false,
      parentName: parent ? parent.name : null,
      children: []
    };

    // Determine drive class
    if (entry.transport === 'nvme') entry.driveClass = 'nvme';
    else if (entry.transport === 'usb' || entry.hotplug) entry.driveClass = 'usb';
    else if (entry.rotational) entry.driveClass = 'hdd';
    else entry.driveClass = 'ssd';

    // Check if this is a system/OS partition
    entry.isSystem = isSystemPartition(entry);

    // Check if convertible
    entry.convertible = isConvertible(entry);
    entry.convertibleReason = getConvertibleReason(entry);

    if (dev.children && dev.children.length > 0) {
      entry.children = dev.children.map(child => processDevice(child, entry));
    }

    return entry;
  }

  for (const dev of (data.blockdevices || [])) {
    const processed = processDevice(dev, null);
    devices.push(processed);
  }

  return devices;
}

/**
 * Get used space for a partition by checking df if mounted,
 * or estimating via fsstat/dumpe2fs for unmounted
 */
async function getDriveDetails(devicePath) {
  const details = { used: 0, usedHuman: '0 B', free: 0, freeHuman: '0 B', usedPercent: 0 };

  try {
    // First get the partition from lsblk
    const { stdout: lsblkOut } = await execFileAsync('lsblk', [
      '--json', '-b', '--output',
      'NAME,PATH,SIZE,FSTYPE,MOUNTPOINT,MOUNTPOINTS,LABEL,UUID,MODEL,TYPE,ROTA,TRAN,PKNAME',
      devicePath
    ]);
    const lsData = JSON.parse(lsblkOut);
    const dev = lsData.blockdevices && lsData.blockdevices[0];
    if (!dev) return details;

    const mountpoint = dev.mountpoint || (dev.mountpoints && dev.mountpoints.find(m => m));

    if (mountpoint) {
      // Mounted: use df with -B1 for bytes (more portable than --bytes)
      const { stdout: dfOut } = await execFileAsync('df', ['-B1', '--output=size,used,avail', mountpoint]);
      const lines = dfOut.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        const total = parseInt(parts[0]) || 0;
        let used = parseInt(parts[1]) || 0;
        const avail = parseInt(parts[2]) || 0;

        // Special case: NTFS or others sometimes report 0 via df if fused or locked incorrectly
        if (used === 0 && total > 1000000) {
          try {
            const { stdout: duOut } = await execFileAsync('du', ['-sb', '--max-depth=0', mountpoint], { timeout: 3000 });
            const duVal = parseInt(duOut.split(/\s+/)[0]);
            if (!isNaN(duVal) && duVal > 0) {
              used = duVal;
              console.log(`DriveScanner: Corrected usage for ${mountpoint} using du: ${formatBytes(duVal)}`);
            }
          } catch (err) {
            console.warn(`DriveScanner: du fallback failed for ${mountpoint}:`, err.message);
          }
        }

        details.used = used;
        details.free = Math.max(0, total - used);
        details.usedHuman = formatBytes(used);
        details.freeHuman = formatBytes(details.free);
        details.usedPercent = total > 0 ? Math.round((used / total) * 100) : 0;
      }
    } else {
      // Unmounted - first try lsblk built-in usage info (might be cached/valid)
      try {
        const { stdout: lbOut } = await execFileAsync('lsblk', ['-b', '-n', '-o', 'FSUSED', devicePath]);
        const lbUsed = parseInt(lbOut.trim());
        if (!isNaN(lbUsed) && lbUsed > 0) {
          details.used = lbUsed;
          details.free = Math.max(0, size - lbUsed);
          details.usedHuman = formatBytes(lbUsed);
          details.freeHuman = formatBytes(details.free);
          details.usedPercent = size > 0 ? Math.round((lbUsed / size) * 100) : 0;
          console.log(`DriveScanner: Got usage for ${devicePath} from lsblk FSUSED: ${formatBytes(lbUsed)}`);
          return details; // Success, skip fs-specific tools
        }
      } catch (err) {
        console.warn(`DriveScanner: lsblk FSUSED failed for ${devicePath}:`, err.message);
      }
      const fstype = dev.fstype;
      const size = parseInt(dev.size) || 0;

      if (fstype === 'ext2' || fstype === 'ext3' || fstype === 'ext4') {
        try {
          const { stdout: e2Out } = await execFileAsync('dumpe2fs', ['-h', devicePath]);
          const blockCount = parseInt((e2Out.match(/Block count:\s+(\d+)/) || [])[1]) || 0;
          const freeBlocks = parseInt((e2Out.match(/Free blocks:\s+(\d+)/) || [])[1]) || 0;
          const blockSize = parseInt((e2Out.match(/Block size:\s+(\d+)/) || [])[1]) || 4096;
          const used = (blockCount - freeBlocks) * blockSize;
          const free = freeBlocks * blockSize;
          details.used = used;
          details.free = free;
          details.usedHuman = formatBytes(used);
          details.freeHuman = formatBytes(free);
          details.usedPercent = blockCount > 0 ? Math.round(((blockCount - freeBlocks) / blockCount) * 100) : 0;
        } catch (_) {
          details.used = Math.floor(size * 0.3);
          details.usedHuman = formatBytes(details.used);
          details.free = size - details.used;
          details.freeHuman = formatBytes(details.free);
          details.usedPercent = 30;
        }
      } else if (fstype === 'ntfs' || fstype === 'ntfs-3g') {
        let ntfsDone = false;

        // Strategy 0: findmnt -S — catches automounts lsblk may miss (GNOME/gvfs, udisks)
        if (!ntfsDone) {
          try {
            const { stdout: fmOut } = await execFileAsync('findmnt', [
              '-S', devicePath, '-n', '-o', 'TARGET,SIZE,AVAIL,USE%'
            ]);
            const fmLine = fmOut.trim().split('\n').find(l => l.trim());
            if (fmLine) {
              const fmParts = fmLine.trim().split(/\s+/);
              const fmTarget = fmParts[0];
              if (fmTarget) {
                const { stdout: dfOut } = await execFileAsync('df', ['-B1', '--output=size,used,avail', fmTarget]);
                const dfLines = dfOut.trim().split('\n');
                if (dfLines.length >= 2) {
                  const parts = dfLines[1].trim().split(/\s+/);
                  const total = parseInt(parts[0]) || 0;
                  const used  = parseInt(parts[1]) || 0;
                  const avail = parseInt(parts[2]) || 0;
                  details.used = used;
                  details.free = avail;
                  details.usedHuman = formatBytes(used);
                  details.freeHuman = formatBytes(avail);
                  details.usedPercent = total > 0 ? Math.round((used / total) * 100) : 0;
                  ntfsDone = true;
                }
              }
            }
          } catch (_) { /* findmnt failed */ }
        }

        // Strategy 0: blkid/metadata check for encryption (BitLocker, LUKS)
        if (!ntfsDone) {
          try {
            const { stdout: bOut } = await execFileAsync('blkid', ['-o', 'export', devicePath], { timeout: 3000 });
            if (bOut.includes('TYPE=BitLocker') || bOut.includes('TYPE=crypto_LUKS')) {
              details.error = bOut.includes('BitLocker') ? 'Encrypted (BitLocker)' : 'Encrypted (LUKS)';
              details.encrypted = true;
              details.used = size;
              details.usedHuman = formatBytes(size);
              details.usedPercent = 100;
              ntfsDone = true;
            }
          } catch (_) {}
        }

        // Strategy 1: ntfsinfo WITHOUT -m (volume info mode — gives Free clusters, Cluster size)
        if (!ntfsDone) {
          try {
            const { stdout: niOut } = await execFileAsync('ntfsinfo', [devicePath], { timeout: 4000 });
            // Handle commas in numbers (common in some locales/versions)
            const clean = (s) => (s || '').replace(/,/g, '');
            const totalClusters = parseInt(clean((niOut.match(/Volume size in clusters\s*:\s*([\d,]+)/i) || [])[1])) || 0;
            const freeClusters = parseInt(clean((niOut.match(/Free clusters\s*:\s*([\d,]+)/i) || [])[1])) || 0;
            const clusterBytes = parseInt(clean((niOut.match(/Cluster size\s*:\s*([\d,]+)/i) || [])[1])) || 4096;

            if (totalClusters > 0) {
              const used = (totalClusters - freeClusters) * clusterBytes;
              const free = freeClusters * clusterBytes;
              details.used = used;
              details.free = free;
              details.usedHuman = formatBytes(used);
              details.freeHuman = formatBytes(free);
              details.usedPercent = Math.round(((totalClusters - freeClusters) / totalClusters) * 100);
              ntfsDone = true;
            }
          } catch (_) { /* ntfsinfo failed/timeout */ }
        }

        // Strategy 2: ntfsresize --info
        if (!ntfsDone) {
          try {
            const { stdout: rzOut } = await execFileAsync('ntfsresize', ['--info', '--force', '--no-progress-bar', devicePath], { timeout: 4000 });
            const m = rzOut.match(/Currently used space[^:]*:\s*(\d+)/i);
            if (m) {
              const used = parseInt(m[1]) || 0;
              const free = Math.max(0, size - used);
              details.used = used;
              details.free = free;
              details.usedHuman = formatBytes(used);
              details.freeHuman = formatBytes(free);
              details.usedPercent = size > 0 ? Math.round((used / size) * 100) : 0;
              ntfsDone = true;
            }
          } catch (_) { /* ntfsresize failed/timeout */ }
        }

        // Strategy 3: python3 — read NTFS boot sector cluster counts directly from device
        // Works without root if user has read access to the block device (disk/storage group)
        if (!ntfsDone) {
          try {
            const pyScript = [
              'import struct, sys',
              'f = open(sys.argv[1], "rb")',
              'f.seek(0)',
              'b = f.read(512)',
              'f.close()',
              // NTFS BPB offsets (all little-endian)
              'bps = struct.unpack_from("<H", b, 11)[0]',   // bytes per sector
              'spc = struct.unpack_from("<B", b, 13)[0]',   // sectors per cluster
              'ts  = struct.unpack_from("<q", b, 40)[0]',   // total sectors (signed)
              'cs  = bps * spc',                             // cluster size
              'tc  = abs(ts) // spc if spc else 0',         // total clusters
              // Free clusters need MFT $Bitmap — not in boot sector.
              // Print what we have so caller can at least show total size consistency.
              'print(cs, tc)',
            ].join('; ');
            const { stdout: pyOut } = await execFileAsync('python3', ['-c', pyScript, devicePath]);
            const [csStr, tcStr] = pyOut.trim().split(' ');
            const cs = parseInt(csStr) || 0;
            const tc = parseInt(tcStr) || 0;
            // We can verify total size matches — if so, we trust the device is readable
            // but can't get free space from boot sector alone. Fall through.
            if (cs > 0 && tc > 0) {
              // Device is readable but free cluster info needs $Bitmap — skip to mount
            }
          } catch (_) { /* python3 not available */ }
        }

        // Strategy 4: temporary read-only ntfs-3g mount + df
        if (!ntfsDone) {
          const tmpMount = `/tmp/transmute-ntfs-${Date.now()}`;
          try {
            const { execFileSync: execSync } = require('child_process');
            execSync('mkdir', ['-p', tmpMount]);
            try {
              execSync('mount', ['-t', 'ntfs-3g', '-o', 'ro,noatime', devicePath, tmpMount]);
              try {
                const { stdout: dfOut } = await execFileAsync('df', ['-B1', '--output=size,used,avail', tmpMount]);
                const lines = dfOut.trim().split('\n');
                if (lines.length >= 2) {
                  const parts = lines[1].trim().split(/\s+/);
                  const total = parseInt(parts[0]) || 0;
                  const used  = parseInt(parts[1]) || 0;
                  const avail = parseInt(parts[2]) || 0;
                  details.used = used;
                  details.free = avail;
                  details.usedHuman = formatBytes(used);
                  details.freeHuman = formatBytes(avail);
                  details.usedPercent = total > 0 ? Math.round((used / total) * 100) : 0;
                  ntfsDone = true;
                }
              } finally {
                try { execSync('umount', [tmpMount]); } catch (_) {}
              }
            } finally {
              try { execSync('rmdir', [tmpMount]); } catch (_) {}
            }
          } catch (_) { /* mount failed — likely no root */ }
        }

        // Strategy 5: give up gracefully — show "—" rather than a fake value
        if (!ntfsDone) {
          details.used = null;
          details.free = null;
          details.usedHuman = null;
          details.freeHuman = null;
          details.usedPercent = 0;
          details.unknown = true;
        }
      } else if (fstype === 'xfs') {
        try {
          const { stdout: xfsOut } = await execFileAsync('xfs_db', ['-r', '-c', 'sb 0', '-c', 'p', devicePath]);
          const dblocks = parseInt((xfsOut.match(/dblocks = (\d+)/) || [])[1]) || 0;
          const fdblocks = parseInt((xfsOut.match(/fdblocks = (\d+)/) || [])[1]) || 0;
          const blocksize = parseInt((xfsOut.match(/blocksize = (\d+)/) || [])[1]) || 4096;
          const used = (dblocks - fdblocks) * blocksize;
          const free = fdblocks * blocksize;
          details.used = used;
          details.free = free;
          details.usedHuman = formatBytes(used);
          details.freeHuman = formatBytes(free);
          details.usedPercent = dblocks > 0 ? Math.round(((dblocks - fdblocks) / dblocks) * 100) : 0;
        } catch (_) {
          details.used = Math.floor(size * 0.4);
          details.usedHuman = formatBytes(details.used);
          details.free = size - details.used;
          details.freeHuman = formatBytes(details.free);
          details.usedPercent = 40;
        }
      } else if (fstype === 'btrfs') {
        try {
          const { stdout: btrfsOut } = await execFileAsync('btrfs', ['inspect-internal', 'dump-super', devicePath]);
          const totalBytes = parseInt((btrfsOut.match(/total_bytes\s+(\d+)/) || [])[1]) || size;
          const bytesUsed = parseInt((btrfsOut.match(/bytes_used\s+(\d+)/) || [])[1]) || 0;
          details.used = bytesUsed;
          details.free = totalBytes - bytesUsed;
          details.usedHuman = formatBytes(bytesUsed);
          details.freeHuman = formatBytes(details.free);
          details.usedPercent = totalBytes > 0 ? Math.round((bytesUsed / totalBytes) * 100) : 0;
        } catch (_) {
          details.used = Math.floor(size * 0.35);
          details.usedHuman = formatBytes(details.used);
          details.free = size - details.used;
          details.freeHuman = formatBytes(details.free);
          details.usedPercent = 35;
        }
      } else {
        // Generic fallback
        details.used = Math.floor(size * 0.4);
        details.usedHuman = formatBytes(details.used);
        details.free = size - details.used;
        details.freeHuman = formatBytes(details.free);
        details.usedPercent = 40;
      }
    }
  } catch (err) {
    details.error = err.message;
  }

  return details;
}

/**
 * Check available disk space at a given path
 */
async function getAvailableSpace(dirPath) {
  try {
    const { stdout } = await execFileAsync('df', ['--bytes', '--output=avail', dirPath]);
    const lines = stdout.trim().split('\n');
    return parseInt(lines[lines.length - 1].trim()) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Get mounted filesystems for staging candidate detection
 */
async function getMountedFilesystems() {
  try {
    const { stdout } = await execFileAsync('findmnt', ['--json', '--output', 'TARGET,SOURCE,FSTYPE,SIZE,AVAIL,USE%']);
    const data = JSON.parse(stdout);
    return (data.filesystems || []).filter(fs =>
      fs.target && fs.target.startsWith('/') &&
      !fs.target.startsWith('/sys') &&
      !fs.target.startsWith('/proc') &&
      !fs.target.startsWith('/dev') &&
      !fs.target.startsWith('/run') &&
      fs.fstype !== 'tmpfs' &&
      fs.fstype !== 'devtmpfs' &&
      fs.fstype !== 'cgroup' &&
      fs.fstype !== 'cgroup2' &&
      fs.fstype !== 'pstore' &&
      fs.fstype !== 'efivarfs' &&
      fs.fstype !== 'bpf' &&
      fs.fstype !== 'securityfs' &&
      fs.fstype !== 'debugfs'
    );
  } catch (_) {
    return [];
  }
}

function isSystemPartition(dev) {
  const mounts = dev.mountpoints || (dev.mountpoint ? [dev.mountpoint] : []);
  const systemMounts = ['/', '/boot', '/boot/efi', '/efi', '/usr', '/var'];
  return mounts.some(m => m && systemMounts.includes(m));
}

function isConvertible(dev) {
  if (dev.readonly) return false;
  if (dev.type !== 'part' && dev.type !== 'disk') return false;
  if (isSystemPartition(dev)) return false;
  if (!dev.fstype) return false;
  const supported = ['ntfs', 'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'vfat', 'fat32', 'exfat'];
  return supported.includes(dev.fstype);
}

function getConvertibleReason(dev) {
  if (dev.readonly) return 'Read-only device';
  if (dev.type !== 'part' && dev.type !== 'disk') return `Not a partition (${dev.type})`;
  if (isSystemPartition(dev)) return 'System partition — boot from live USB to convert';
  if (!dev.fstype) return 'No filesystem detected (unformatted or encrypted)';
  const supported = ['ntfs', 'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'vfat', 'fat32', 'exfat'];
  if (!supported.includes(dev.fstype)) return `Filesystem '${dev.fstype}' not supported for conversion`;
  return null;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val % 1 === 0 ? val : val.toFixed(1)} ${units[Math.min(i, units.length - 1)]}`;
}

module.exports = { scanDrives, getDriveDetails, getAvailableSpace, getMountedFilesystems, formatBytes };
