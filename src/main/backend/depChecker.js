'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const REQUIRED_TOOLS = [
  { name: 'rsync',     cmd: 'rsync',     args: ['--version'],       purpose: 'Data copying and verification' },
  { name: 'lsblk',    cmd: 'lsblk',     args: ['--version'],       purpose: 'Block device listing' },
  { name: 'blkid',    cmd: 'blkid',     args: ['--version'],       purpose: 'Filesystem UUID detection' },
  { name: 'findmnt',  cmd: 'findmnt',   args: ['--version'],       purpose: 'Mountpoint detection' },
  { name: 'parted',   cmd: 'parted',    args: ['--version'],       purpose: 'Partition management' },
  { name: 'mount',    cmd: 'mount',     args: ['--version'],       purpose: 'Mounting filesystems' },
  { name: 'umount',   cmd: 'umount',    args: ['--version'],       purpose: 'Unmounting filesystems' },
];

const OPTIONAL_TOOLS = [
  { name: 'mkfs.ext4',   cmd: 'mkfs.ext4',   args: ['--version'],   purpose: 'Format as ext4' },
  { name: 'mkfs.ext3',   cmd: 'mkfs.ext3',   args: ['--version'],   purpose: 'Format as ext3' },
  { name: 'mkfs.xfs',    cmd: 'mkfs.xfs',    args: ['-V'],          purpose: 'Format as xfs' },
  { name: 'mkfs.btrfs',  cmd: 'mkfs.btrfs',  args: ['--version'],   purpose: 'Format as btrfs' },
  { name: 'mkfs.f2fs',   cmd: 'mkfs.f2fs',   args: ['-V'],          purpose: 'Format as f2fs' },
  { name: 'mkfs.vfat',   cmd: 'mkfs.vfat',   args: ['--version'],   purpose: 'Format as FAT32' },
  { name: 'mkfs.exfat',  cmd: 'mkfs.exfat',  args: ['--version'],   purpose: 'Format as exFAT' },
  { name: 'mkfs.ntfs',   cmd: 'mkntfs',      args: ['--version'],   purpose: 'Format as NTFS' },
  { name: 'ntfs-3g',     cmd: 'ntfs-3g',     args: ['--version'],   purpose: 'NTFS read/write support' },
  { name: 'dumpe2fs',    cmd: 'dumpe2fs',    args: ['-h', '/dev/null'], purpose: 'ext4 filesystem info' },
  { name: 'xfs_db',      cmd: 'xfs_db',      args: ['-V'],          purpose: 'XFS filesystem info' },
  { name: 'btrfs',       cmd: 'btrfs',       args: ['--version'],   purpose: 'Btrfs filesystem tools' },
  { name: 'tune2fs',     cmd: 'tune2fs',     args: ['-l', '/dev/null'], purpose: 'ext filesystem tuning' },
  { name: 'xfs_admin',   cmd: 'xfs_admin',   args: ['-V'],          purpose: 'XFS administration' },
  { name: 'ntfsinfo',    cmd: 'ntfsinfo',    args: ['--version'],   purpose: 'NTFS info tool' },
  { name: 'pkexec',      cmd: 'pkexec',      args: ['--version'],   purpose: 'Privilege escalation (polkit)' },
  { name: 'sudo',        cmd: 'sudo',        args: ['--version'],   purpose: 'Privilege escalation (sudo)' },
];

async function checkTool(tool) {
  try {
    await execFileAsync(tool.cmd, tool.args, { timeout: 3000 });
    return { ...tool, available: true, error: null };
  } catch (err) {
    // Some tools return non-zero for --version but still exist
    if (err.code === 'ENOENT') {
      return { ...tool, available: false, error: 'Not found' };
    }
    // Exists but returned error code - still consider available
    return { ...tool, available: true, error: null };
  }
}

async function checkDependencies() {
  const [required, optional] = await Promise.all([
    Promise.all(REQUIRED_TOOLS.map(checkTool)),
    Promise.all(OPTIONAL_TOOLS.map(checkTool))
  ]);

  const missingRequired = required.filter(t => !t.available);
  const availableOptional = optional.filter(t => t.available);

  // Build set of available filesystem targets
  const availableTargets = new Set();
  const fsToolMap = {
    'ext4': 'mkfs.ext4',
    'ext3': 'mkfs.ext3',
    'xfs': 'mkfs.xfs',
    'btrfs': 'mkfs.btrfs',
    'f2fs': 'mkfs.f2fs',
    'vfat': 'mkfs.vfat',
    'exfat': 'mkfs.exfat',
    'ntfs': 'mkfs.ntfs',
  };

  for (const [fs, toolName] of Object.entries(fsToolMap)) {
    if (availableOptional.find(t => t.name === toolName)) {
      availableTargets.add(fs);
    }
  }

  // Check privilege escalation method
  let privMethod = null;
  if (availableOptional.find(t => t.name === 'pkexec')) privMethod = 'pkexec';
  else if (availableOptional.find(t => t.name === 'sudo')) privMethod = 'sudo';

  // Check if running as root already
  const isRoot = process.getuid && process.getuid() === 0;

  return {
    ok: missingRequired.length === 0,
    required,
    optional,
    missingRequired,
    availableTargets: Array.from(availableTargets),
    privMethod,
    isRoot,
    installHints: getInstallHints(missingRequired, optional)
  };
}

function getInstallHints(missingRequired, optional) {
  const hints = [];
  const missing = [...missingRequired, ...optional.filter(t => !t.available)];

  const packageMap = {
    'rsync': 'rsync',
    'parted': 'parted',
    'mkfs.ext4': 'e2fsprogs',
    'mkfs.xfs': 'xfsprogs',
    'mkfs.btrfs': 'btrfs-progs',
    'mkfs.f2fs': 'f2fs-tools',
    'mkfs.vfat': 'dosfstools',
    'mkfs.exfat': 'exfatprogs (or exfat-utils)',
    'mkfs.ntfs': 'ntfs-3g',
    'ntfs-3g': 'ntfs-3g',
    'dumpe2fs': 'e2fsprogs',
    'xfs_db': 'xfsprogs',
    'btrfs': 'btrfs-progs',
    'tune2fs': 'e2fsprogs',
    'ntfsinfo': 'ntfs-3g',
  };

  const needed = missing.map(t => packageMap[t.name]).filter(Boolean);
  const unique = [...new Set(needed)];

  if (unique.length > 0) {
    hints.push({
      fedora: `sudo dnf install ${unique.join(' ')}`,
      debian: `sudo apt install ${unique.join(' ')}`,
      arch: `sudo pacman -S ${unique.join(' ')}`
    });
  }

  return hints;
}

module.exports = { checkDependencies };
