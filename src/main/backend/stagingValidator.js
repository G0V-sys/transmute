'use strict';

const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const execFileAsync = promisify(execFile);
const { getMountedFilesystems, formatBytes } = require('./driveScanner');

/**
 * Get candidate staging locations for a conversion job
 */
async function getStagingLocations() {
  const locations = [];

  // 1. Mounted filesystems with sufficient space
  try {
    const mounts = await getMountedFilesystems();
    for (const mount of mounts) {
      if (!mount.target || mount.target === '/') continue;
      try {
        const { stdout } = await execFileAsync('df', ['-B1', '--output=avail', mount.target]);
        const lines = stdout.trim().split('\n');
        const avail = parseInt(lines[lines.length - 1].trim()) || 0;
        if (avail > 0) {
          locations.push({
            type: 'directory',
            label: mount.target,
            path: mount.target,
            fstype: mount.fstype,
            available: avail,
            availableHuman: formatBytes(avail),
            description: `${mount.source || ''} (${mount.fstype})`
          });
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 2. Home directory
  const home = process.env.HOME || '/home';
  try {
    const { stdout } = await execFileAsync('df', ['-B1', '--output=avail', home]);
    const lines = stdout.trim().split('\n');
    const avail = parseInt(lines[lines.length - 1].trim()) || 0;
    if (!locations.find(l => l.path === home) && avail > 0) {
      locations.push({
        type: 'directory',
        label: 'Home Directory',
        path: home,
        available: avail,
        availableHuman: formatBytes(avail),
        description: `${home}`
      });
    }
  } catch (_) {}

  // 3. /tmp
  try {
    const { stdout } = await execFileAsync('df', ['-B1', '--output=avail', '/tmp']);
    const lines = stdout.trim().split('\n');
    const avail = parseInt(lines[lines.length - 1].trim()) || 0;
    if (avail > 1073741824) { // Only if > 1GB
      locations.push({
        type: 'directory',
        label: '/tmp',
        path: '/tmp',
        available: avail,
        availableHuman: formatBytes(avail),
        description: 'Temporary storage'
      });
    }
  } catch (_) {}

  return locations;
}

/**
 * Validate that a staging option has enough space for the given data size
 */
async function validateStaging(opts) {
  const { stagingType, stagingPath, requiredBytes } = opts;

  const result = {
    valid: false,
    available: 0,
    availableHuman: '0 B',
    required: requiredBytes,
    requiredHuman: formatBytes(requiredBytes),
    error: null
  };

  try {
    if (stagingType === 'directory' || stagingType === 'image') {
      const dirToCheck = stagingType === 'image' ? path.dirname(stagingPath) : stagingPath;

      // Check directory exists and is writable
      try {
        fs.accessSync(dirToCheck, fs.constants.W_OK);
      } catch (_) {
        result.error = `Directory ${dirToCheck} is not writable`;
        return result;
      }

      const { stdout } = await execFileAsync('df', ['-B1', '--output=avail', dirToCheck]);
      const lines = stdout.trim().split('\n');
      const avail = parseInt(lines[lines.length - 1].trim()) || 0;
      result.available = avail;
      result.availableHuman = formatBytes(avail);

      // Need 110% of data to account for filesystem overhead
      const needed = Math.floor(requiredBytes * 1.1);
      result.valid = avail >= needed;
      if (!result.valid) {
        result.error = `Insufficient space: need ${formatBytes(needed)}, have ${formatBytes(avail)}`;
      }
    } else if (stagingType === 'nfs' || stagingType === 'smb') {
      // Network staging - check mount point
      try {
        fs.accessSync(stagingPath, fs.constants.W_OK);
        const { stdout } = await execFileAsync('df', ['-B1', '--output=avail', stagingPath]);
        const lines = stdout.trim().split('\n');
        const avail = parseInt(lines[lines.length - 1].trim()) || 0;
        result.available = avail;
        result.availableHuman = formatBytes(avail);
        const needed = Math.floor(requiredBytes * 1.1);
        result.valid = avail >= needed;
        if (!result.valid) {
          result.error = `Insufficient space on network share`;
        }
      } catch (_) {
        result.error = `Network path ${stagingPath} is not accessible`;
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = { getStagingLocations, validateStaging };
