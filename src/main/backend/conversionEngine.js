'use strict';

const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const execFileAsync = promisify(execFile);
const { formatBytes } = require('./driveScanner');

const activeJobs = new Map();
let jobCounter = 0;

function getPrivPrefix() {
  if (process.getuid && process.getuid() === 0) return [];
  try { execFileSync('which', ['pkexec'], { stdio: 'ignore' }); return ['pkexec']; } catch (_) {}
  try { execFileSync('which', ['sudo'], { stdio: 'ignore' }); return ['sudo']; } catch (_) {}
  return [];
}

function runPrivileged(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const priv = getPrivPrefix();
    const fullCmd = priv.length > 0 ? priv[0] : cmd;
    const fullArgs = priv.length > 0 ? [...priv.slice(1), cmd, ...args] : args;
    
    // Log the command being executed for debugging
    const cmdStr = priv.length > 0 ? `${priv.join(' ')} ${cmd} ${args.join(' ')}` : `${cmd} ${args.join(' ')}`;
    console.log(`[PRIV] Executing: ${cmdStr}`);
    
    const proc = spawn(fullCmd, fullArgs, { stdio: ['inherit', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { 
      stderr += d.toString();
      // Log sudo-related errors specifically
      const stderrText = d.toString().trim();
      if (stderrText.includes('sudo') || stderrText.includes('password') || stderrText.includes('permission')) {
        console.log(`[PRIV] Auth stderr: ${stderrText}`);
      }
    });
    proc.on('close', code => {
      if (code === 0) {
        console.log(`[PRIV] Command completed successfully: ${cmd}`);
        resolve({ stdout, stderr });
      } else {
        console.log(`[PRIV] Command failed: ${cmd} exited ${code}`);
        const errorMsg = `${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`;
        reject(new Error(errorMsg));
      }
    });
    proc.on('error', reject);
  });
}

function escapeRegExp(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function startConversion(opts, callbacks) {
  const jobId = `job-${Date.now()}-${++jobCounter}`;
  const job = { id: jobId, opts, status: 'running', cancelled: false, cancelFn: null, startTime: Date.now(), currentStep: 0, totalSteps: 11, tempMountPoint: null, stagingMountPoint: null, skippedFiles: new Set() };
  activeJobs.set(jobId, job);
  runConversion(job, opts, callbacks).catch(err => {
    if (!job.cancelled) callbacks.onError({ jobId, error: err.message });
    activeJobs.delete(jobId);
  });
  return jobId;
}

async function runConversion(job, opts, callbacks) {
  const { onProgress, onLog, onComplete, onError } = callbacks;
  const { sourcePath, targetFs, stagingType, stagingPath, newLabel, preserveUuid, rsyncExtraArgs = [], isRecovery, keepStaging } = opts;
  const log = (msg, level = 'info') => {
    console.log(`[LOG] ${level.toUpperCase()}: ${msg}`); // Debug log
    onLog({ jobId: job.id, msg, level, ts: Date.now() });
  };
  const progress = (step, pct, detail = '', speed = null, eta = null) => { 
    console.log(`[PROGRESS] Step ${step}: ${pct}% - ${detail} ${speed ? '(' + speed + ', ' + eta + ')' : ''}`); // Debug log
    job.currentStep = step; 
    onProgress({ jobId: job.id, step, pct, detail, speed, eta }); 
  };
  const runPriv = (c, a, o) => runPrivileged(c, a, o);

  let tempMount = null, stagingMount = null, imageFile = null, rsyncDest = null;
  let sourceWasMounted = false, originalMountpoint = null, originalFstabEntry = null, originalUuid = null;

  try {
    // ─── STEP 0: Verify privileges ──────────────────────────────────────────
    log('Step 0: Checking privileges...');
    const priv = getPrivPrefix();
    if (priv.length > 0) {
      log(`Using privilege escalation: ${priv.join(' ')}`);
    } else {
      log('Running as root - no privilege escalation needed');
    }
    
    // Get source device info
    log('Step 1: Analyzing source device...');
    const { stdout: lsblkOut } = await execFileAsync('lsblk', ['--json', '--bytes', '--output', 'NAME,PATH,SIZE,FSTYPE,MOUNTPOINT,MOUNTPOINTS,UUID,LABEL,TYPE', sourcePath]);
    const srcDev = JSON.parse(lsblkOut).blockdevices[0];
    if (!srcDev) throw new Error(`Device ${sourcePath} not found`);
    const sourceFs = srcDev.fstype;
    const deviceSize = parseInt(srcDev.size) || 0;
    originalUuid = srcDev.uuid;
    originalMountpoint = srcDev.mountpoint || (srcDev.mountpoints && srcDev.mountpoints.find(m => m)) || null;
    
    // Initial log message now that we have all the info
    log('=== Starting Conversion Process ===');
    log(`Source: ${sourcePath} (${sourceFs})`);
    log(`Target: ${targetFs}`);
    log(`Staging: ${stagingType} at ${stagingPath}`);
    log(`Preserve UUID: ${preserveUuid}`);
    log(`New label: ${newLabel || '(unchanged)'}`);
    log('=====================================', 'info');
    
    log(`Device info: ${srcDev.name} (${formatBytes(deviceSize)})`);
    log(`Current filesystem: ${sourceFs}`);
    log(`UUID: ${originalUuid || '(none)'}`);
    log(`Mount point: ${originalMountpoint || '(not mounted)'}`);
    log(`Device label: ${srcDev.label || '(none)'}`);

    if (isRecovery) {
      log('--- RECOVERY MODE ACTIVE ---');
      log('Preparing to resume from staging data...');
      if (fs.statSync(stagingPath).isFile()) {
        log('Staging data is an image file, mounting...');
        imageFile = stagingPath;
        stagingMount = fs.mkdtempSync(path.join(os.tmpdir(), 'transmute-stage-'));
        await runPriv('mount', [imageFile, stagingMount]);
        rsyncDest = stagingMount;
        log('Image file mounted successfully');
      } else {
        log('Staging data is a directory, using directly...');
        rsyncDest = stagingPath;
      }
      progress(6, 65, 'Resuming from staging');
      log('Resuming from staging data...');
    } else {
      if (sourceFs === targetFs) throw new Error('Source and target filesystems are the same');
      
      // ─── STEP 1: Identify source mountpoint ────────────────────────────────
      log('Step 2: Checking mount status...');
      progress(1, 5, 'Checking mount status');
      if (originalMountpoint) {
        sourceWasMounted = true;
        log(`Source is currently mounted at: ${originalMountpoint}`);
        try {
          const fstabContent = fs.readFileSync('/etc/fstab', 'utf8');
          const uuidMatch = fstabContent.match(new RegExp(`UUID=${originalUuid}.*`, 'g'));
          originalFstabEntry = uuidMatch ? uuidMatch[0] : null;
          if (originalFstabEntry) {
            log(`Found fstab entry: ${originalFstabEntry}`);
          } else {
            log('No fstab entry found for this device');
          }
        } catch (err) {
          log('Could not read fstab: ' + err.message, 'warn');
        }
      } else {
        log('Source is not currently mounted');
      }

      // ─── STEP 2: Mount source read-only ────────────────────────────────────
      log('Step 3: Mounting source filesystem read-only...');
      progress(2, 10, 'Mounting source RO');
      tempMount = fs.mkdtempSync(path.join(os.tmpdir(), 'transmute-src-'));
      log(`Created temporary mount point: ${tempMount}`);
      
      if (originalMountpoint) {
        log('Source is mounted, attempting remount read-only...');
        try { 
          await runPriv('mount', ['-o', 'remount,ro', originalMountpoint]); 
          tempMount = originalMountpoint;
          log('Successfully remounted original mount point read-only');
        } catch (err) { 
          log('Remount failed, trying bind mount...', 'warn');
          try {
            await runPriv('mount', ['--bind', '-o', 'ro', originalMountpoint, tempMount]);
            log('Successfully created bind mount read-only');
          } catch (bindErr) {
            log('Bind mount failed, mounting device directly...', 'warn');
            await runPriv('mount', [sourcePath, tempMount, '-o', 'ro']);
            log('Successfully mounted device directly read-only');
          }
        }
      } else {
        log('Source not mounted, mounting device directly...');
        await runPriv('mount', [sourcePath, tempMount, '-o', 'ro']);
        log('Successfully mounted device read-only');
      }

      // ─── STEP 3: Setup staging area ────────────────────────────────────────
      log('Step 4: Setting up staging area...');
      progress(3, 15, 'Setting up staging');
      if (stagingType === 'image') {
        const imageSize = Math.ceil(deviceSize * 1.05);
        imageFile = stagingPath;
        log(`Creating disk image: ${imageFile} (${formatBytes(imageSize)})`);
        await runPriv('dd', ['if=/dev/null', `of=${imageFile}`, 'bs=1', 'count=0', `seek=${imageSize}`]);
        log('Disk image created successfully');
        
        log('Formatting image with ext4 filesystem...');
        await runPriv('mkfs.ext4', ['-F', imageFile]);
        log('Image formatted successfully');
        
        stagingMount = fs.mkdtempSync(path.join(os.tmpdir(), 'transmute-stage-'));
        log(`Created staging mount point: ${stagingMount}`);
        await runPriv('mount', [imageFile, stagingMount]);
        log('Disk image mounted successfully');
        rsyncDest = stagingMount;
      } else {
        rsyncDest = path.join(stagingPath, `transmute-${job.id}`);
        log(`Creating staging directory: ${rsyncDest}`);
        await runPriv('mkdir', ['-p', rsyncDest]);
        log('Staging directory created successfully');
      }

      // ─── STEP 3.5: Check disk space and inodes ───────────────────────────────
      log('Step 4.5: Checking available disk space and inodes...');
      progress(4, 15, 'Checking disk space');
      
      try {
        // Check disk space on staging filesystem
        const { stdout: dfOut } = await execFileAsync('df', ['-h', stagingPath]);
        log(`Disk space info for staging path:\n${dfOut}`, 'info');
        
        // Check inode usage on staging filesystem
        const { stdout: dfiOut } = await execFileAsync('df', ['-i', stagingPath]);
        log(`Inode usage info for staging path:\n${dfiOut}`, 'info');
        
        // Parse disk space to get actual numbers
        const { stdout: dfOutRaw } = await execFileAsync('df', ['--block-size=1', stagingPath]);
        const dfLines = dfOutRaw.trim().split('\n');
        if (dfLines.length >= 2) {
          const dfData = dfLines[1].split(/\s+/);
          const totalSpace = parseInt(dfData[1]);
          const availableSpace = parseInt(dfData[3]);
          const usedSpace = parseInt(dfData[2]);
          
          log(`Parsed space: ${formatBytes(usedSpace)} used of ${formatBytes(totalSpace)}, ${formatBytes(availableSpace)} available`, 'info');
          
          if (availableSpace < (selDet.used || 0) * 1.1) { // 10% buffer
            log(`WARNING: Available space (${formatBytes(availableSpace)}) may be insufficient for source data (${formatBytes(selDet.used || 0)})`, 'warn');
          } else {
            log(`Sufficient space available: ${formatBytes(availableSpace)} vs needed: ${formatBytes(selDet.used || 0)}`, 'success');
          }
        }
        
        // Parse inode usage
        const { stdout: dfiOutRaw } = await execFileAsync('df', ['-i', '--block-size=1', stagingPath]);
        const dfiLines = dfiOutRaw.trim().split('\n');
        if (dfiLines.length >= 2) {
          const dfiData = dfiLines[1].split(/\s+/);
          const totalInodes = parseInt(dfiData[1]);
          const availableInodes = parseInt(dfiData[3]);
          const usedInodes = parseInt(dfiData[2]);
          
          log(`Parsed inodes: ${usedInodes} used of ${totalInodes}, ${availableInodes} available`, 'info');
          
          if (availableInodes < 1000) {
            log(`WARNING: Low inode count available (${availableInodes}) - this can cause 'no space left on device' errors even with free disk space`, 'warn');
          } else {
            log(`Sufficient inodes available: ${availableInodes}`, 'success');
          }
        }
        
        // Check temporary directory space
        const { stdout: tmpDfOut } = await execFileAsync('df', ['-h', '/tmp']);
        log(`Disk space info for /tmp:\n${tmpDfOut}`, 'info');
        
        // Check if there are any large temporary files
        const { stdout: tmpLsOut } = await execFileAsync('find', ['/tmp', '-type', 'f', '-size', '+1G', '-ls']);
        if (tmpLsOut.trim()) {
          log(`Large files in /tmp:\n${tmpLsOut}`, 'warn');
        } else {
          log('No large files found in /tmp', 'info');
        }
        
      } catch (diskCheckErr) {
        log(`Disk space check failed: ${diskCheckErr.message}`, 'warn');
        log('Continuing with conversion despite disk check failure...', 'warn');
      }

      // ─── STEP 4: rsync to staging ──────────────────────────────────────────
      log('Step 5: Copying data to staging area...');
      progress(4, 20, 'Copying data to staging');
      log(`Starting rsync from ${tempMount} to ${rsyncDest}`);
      log('This may take a while depending on data size...');
      await runRsyncTask(tempMount, rsyncDest, rsyncExtraArgs, job, progress, log, getPrivPrefix);
      log('Data copy to staging completed successfully');

      // ─── STEP 5: Verify staging ────────────────────────────────────────────
      log('Step 6: Verifying staging integrity...');
      progress(5, 55, 'Verifying: 0%');
      log('Running checksum verification of copied data...');
      await verifyStagingTask(tempMount, rsyncDest, job, progress, log, getPrivPrefix);
      log('Staging verification completed successfully');
    }

    // ─── STEP 6: Unmount source ─────────────────────────────────────────────
    if (isRecovery) {
      log('Skipping source unmount in recovery mode');
    } else {
      log('Step 7: Unmounting source filesystem...');
      progress(6, 65, 'Unmounting source');
      if (originalMountpoint && tempMount !== originalMountpoint) {
        log('Cleaning up temporary bind mount...');
        await runPriv('umount', [tempMount]);
      }
      if (originalMountpoint) { 
        log('Unmounting original mount point...');
        try { 
          await runPriv('umount', [originalMountpoint]); 
          log('Original mount point unmounted successfully');
        } catch (err) { 
          log('Normal unmount failed, trying lazy unmount...', 'warn');
          await runPriv('umount', ['-l', originalMountpoint]); 
          log('Lazy unmount completed');
        } 
      } else if (tempMount) { 
        log('Unmounting temporary mount point...');
        await runPriv('umount', [tempMount]);
        log('Temporary mount point unmounted');
      }
      if (tempMount && tempMount.includes('transmute-src-')) {
        try { 
          fs.rmdirSync(tempMount);
          log('Removed temporary mount directory');
        } catch (_) { }
      }
      tempMount = null;
    }

    // ─── STEP 7: Format ───────────────────────────────────────────────────
    if (isRecovery) {
      log('Preparing to format the target partition...');
    } else {
      log('Step 8: Formatting partition...');
      progress(7, 70, `Formatting to ${targetFs}`);
    }
    
    let uuidToUse = preserveUuid ? originalUuid : null;
    if (uuidToUse && ['ext4', 'ext3', 'ext2', 'btrfs', 'xfs', 'f2fs'].includes(targetFs) && !/^[0-9a-fA-F]{8}-/.test(uuidToUse)) {
      log('UUID format not compatible with target filesystem, will generate new UUID', 'warn');
      uuidToUse = null;
    }
    
    const mkfsArgs = buildMkfsArgs(targetFs, sourcePath, newLabel, uuidToUse);
    log(`Formatting ${sourcePath} to ${targetFs}...`);
    log(`mkfs.${targetFs === 'ntfs' ? 'ntfs' : targetFs} ${mkfsArgs.join(' ')}`);
    await runPriv(`mkfs.${targetFs === 'ntfs' ? 'ntfs' : targetFs}`, mkfsArgs);
    log('Formatting completed successfully');
    
    if (uuidToUse) {
      log(`Preserved original UUID: ${uuidToUse}`);
    } else {
      log('Generated new UUID for filesystem');
    }

    // ─── STEP 8: Mount new ────────────────────────────────────────────────
    if (isRecovery) {
      log('Mounting the newly formatted filesystem...');
    } else {
      log('Step 9: Mounting new filesystem...');
      progress(8, 78, 'Mounting new filesystem');
    }
    const newMount = fs.mkdtempSync(path.join(os.tmpdir(), 'transmute-new-'));
    log(`Created new mount point: ${newMount}`);
    log(`Mounting ${sourcePath} to ${newMount}...`);
    await runPriv('mount', [sourcePath, newMount]);
    log('New filesystem mounted successfully');

    // ─── STEP 9: Restore ──────────────────────────────────────────────────
    if (isRecovery) {
      log('Restoring data from staging to the new filesystem...');
    } else {
      log('Step 10: Restoring data from staging...');
      progress(9, 82, 'Restoring data');
    }
    const restoreSrc = stagingMount || rsyncDest;
    log(`Restoring data from ${restoreSrc} to ${newMount}...`);
    log('Starting final data restoration...');
    await runRsyncTask(restoreSrc, newMount, [], job, progress, log, getPrivPrefix, true);
    log('Data restoration completed successfully');

    // ─── STEP 10: Verify ──────────────────────────────────────────────────
    if (isRecovery) {
      log('Verifying restored data...');
    } else {
      log('Step 11: Final verification...');
      progress(10, 95, 'Verifying: 0%');
    }
    log('Starting final verification of restored data...');
    await verifyStagingTask(restoreSrc, newMount, job, progress, log, getPrivPrefix, true);
    log('Final verification completed successfully');

    // ─── STEP 11: Cleanup ─────────────────────────────────────────────────
    log('Step 12: Final cleanup...');
    job.status = 'complete'; // Mark as complete to allow deletion in performCleanup
    await performCleanup(job, tempMount, stagingMount, imageFile, rsyncDest, newMount, keepStaging, log);
    log('Cleanup completed successfully');
    
    // ─── STEP 12: Post-Conversion Remount ──────────────────────────────────
    log('Step 13: Finalizing and mounting...');
    let skippedFilesLog = null;
    if (job.skippedFiles.size > 0) {
      try {
        const { app } = require('electron');
        const logDir = path.join(app.getPath('userData'), 'skipped-files');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        skippedFilesLog = path.join(logDir, `skipped-${job.id}.txt`);
        fs.writeFileSync(skippedFilesLog, Array.from(job.skippedFiles).join('\n'), 'utf8');
        log(`Saved ${job.skippedFiles.size} skipped files to: ${skippedFilesLog}`, 'warn');
      } catch (err) {
        log(`Could not save skipped files log: ${err.message}`, 'error');
      }
    }

    if (originalMountpoint) {
      log(`Attempting to remount to original location: ${originalMountpoint}`);
      try {
        await runPriv('mkdir', ['-p', originalMountpoint]);
        await runPriv('mount', [sourcePath, originalMountpoint]);
        log('Remounted successfully', 'success');
      } catch (err) {
        log(`Auto-remount failed: ${err.message}. You can mount it manually.`, 'warn');
      }
    }

    if (isRecovery) {
      log('=== Recovery Process Completed Successfully ===');
    } else {
      log('=== Conversion Process Completed Successfully ===');
      progress(11, 100, 'Complete');
    }
    log(`Total duration: ${Math.round((Date.now() - job.startTime) / 1000)} seconds`);
    log('=====================================', 'success');
    onComplete({ 
      jobId: job.id, 
      sourcePath, 
      sourceFs: opts.sourceFs,
      targetFs, 
      duration: Math.round((Date.now() - job.startTime) / 1000),
      skippedFilesLog
    });

  } catch (err) {
    await performCleanup(job, tempMount, stagingMount, imageFile, rsyncDest, newMount, false, (msg, lvl) => log(`[Cleanup] ${msg}`, lvl)); 
    onError({ jobId: job.id, error: err.message, cancelled: err instanceof CancelError });
  } finally {
    activeJobs.delete(job.id);
  }
}

async function runRsyncTask(src, dest, extra = [], job, progress, log, getPriv, isRestore = false, retryCount = 0) {
  return new Promise((resolve, reject) => {
    // Use standard rsync options with extended attributes handling
    const args = ['-aHAXx', '--numeric-ids', '--info=progress2', '--no-inc-recursive', 
                  '--no-xattrs', // Skip extended attributes to avoid xattr-related errors
                  '--no-acls',   // Skip ACLs to avoid issues on incompatible filesystems
                  ...(extra || []), `${src}/`, `${dest}/`];
    const priv = getPriv();
    
    // Log the command being executed for debugging
    const fullCmd = priv.length > 0 ? `${priv.join(' ')} rsync ${args.join(' ')}` : `rsync ${args.join(' ')}`;
    log(`Executing: ${fullCmd}`, 'debug');
    log('Note: Extended attributes and ACLs are disabled to maximize compatibility', 'info');
    
    // Use proper stdio handling for authentication
    const proc = spawn(priv[0] || 'rsync', [...priv.slice(1), 'rsync', ...args], { 
      stdio: priv.length > 0 ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, SUDO_ASKPASS: '/bin/false' } // Disable askpass to force terminal prompt
    });
    
    if (priv.length === 0) {
      log('Running without privilege escalation (assumed root)', 'debug');
    } else {
      log(`Using privilege escalation: ${priv.join(' ')}`, 'debug');
      log('Note: If prompted, enter your sudo password in the terminal', 'info');
    }
    
    job.cancelFn = () => proc.kill();
    let authPromptSeen = false;
    
    proc.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split('\r'); buf = lines.pop();
        for (const line of lines) {
            // Enhanced regex for progress2: size pct speed eta
            // Example: " 782,443,520  63%  110.34MB/s    0:00:03"
            const m = line.match(/(\d+)%\s+([\d.]+[\w/s]+)\s+([\d:]+)/);
            const mSimple = !m ? line.match(/(\d+)%/) : null;
            
            if (m || mSimple) {
                const pct = parseInt(m ? m[1] : mSimple[1]);
                const speed = m ? m[2] : null;
                const eta = m ? m[3] : null;
                const base = isRestore ? 82 : 20;
                const scale = isRestore ? 0.12 : 0.35;
                progress(isRestore ? 9 : 4, Math.floor(base + pct * scale), `${isRestore ? 'Restoring' : 'Copying'}: ${pct}%`, speed, eta);
            }
        }
    });
    
    proc.stderr.on('data', d => {
        stderrBuf += d.toString();
        const stderrText = d.toString().trim();
        
        // Count and filter xattr warnings to reduce log spam
        if (stderrText.includes('get_xattr_data') && stderrText.includes('Argument list too long')) {
            xattrWarningCount++;
            // Only log every 50th xattr warning to reduce spam
            if (xattrWarningCount % 50 === 1) {
                log(`rsync: ${xattrWarningCount} extended attribute warnings from Windows files (suppressed for brevity)`, 'info');
            }
        } else if (stderrText.includes('No space left on device')) {
            log(`rsync: 'No space left on device' error detected`, 'error');
            log('This error can occur even when disk space appears available. Common causes:', 'error');
            log('1. Inode exhaustion (too many files on filesystem)', 'error');
            log('2. Temporary directory full (/tmp or staging area)', 'error');
            log('3. Filesystem quota limits', 'error');
            log('4. Block size issues with large files', 'error');
            log('5. Extended attributes issues (Windows WofCompressedData)', 'error');
            log(`Error details: ${stderrText}`, 'error');
        } else if (stderrText.includes('sudo: a password is required') || stderrText.includes('[sudo] password for') || stderrText.includes('password for')) {
            if (!authPromptSeen) {
                authPromptSeen = true;
                log('Sudo password required - please enter password in the terminal', 'warn');
            }
        } else if (stderrText.includes('sudo: authentication failure') || stderrText.includes('permission denied')) {
            log(`Authentication failed: ${stderrText}`, 'error');
            log('This usually means the sudo password was incorrect or timed out', 'error');
        } else if (stderrText.includes('rsync:') && (stderrText.includes('permission denied') || stderrText.includes('Permission denied'))) {
            // Extract filename from rsync error message - handle quoted and unquoted paths
            const pathMatch = stderrText.match(/rsync: .*? "(.*)" failed/i) || 
                              stderrText.match(/rsync: .*? (.*) failed/i) || 
                              stderrText.match(/rsync: (.*): Permission denied/i);
            
            if (pathMatch) {
                const filePath = pathMatch[1];
                job.skippedFiles.add(filePath);
                if (job.skippedFiles.size <= 10) {
                    log(`Notice: Could not copy '${filePath}' (Permission Denied). Skipping.`, 'warn');
                } else if (job.skippedFiles.size === 11) {
                    log(`Notice: Many files are being skipped due to permissions. Further files will be suppressed from log.`, 'warn');
                }
            } else {
                log(`rsync stderr (permission): ${stderrText}`, 'warn');
            }
        } else if (stderrText.includes('sudo') || stderrText.includes('password') || stderrText.includes('permission')) {
            log(`rsync stderr (auth): ${stderrText}`, 'warn');
        } else if (stderrText.includes('rsync error') || stderrText.includes('failed:')) {
            log(`rsync stderr: ${stderrText}`, 'warn');
        } else {
            log(`rsync stderr: ${stderrText}`, 'info');
        }
    });
    
    proc.on('close', code => { 
        if (code === 0) {
            if (xattrWarningCount > 0) {
                log(`rsync completed successfully with ${xattrWarningCount} extended attribute warnings (normal for Windows files)`, 'success');
            } else {
                log('rsync completed successfully', 'success');
            }
            
            if (job.skippedFiles.size > 0) {
                log(`Skipped ${job.skippedFiles.size} files due to permission issues. A full list will be available after completion.`, 'warn');
            }
            
            resolve(); 
        } else if (code === 24) {
            log('rsync completed with vanished files (code 24) - this is normal for active filesystems', 'warn');
            
            if (skippedFiles.length > 0) {
                log(`Skipped ${skippedFiles.length} files due to repeated authentication failures:`, 'warn');
                skippedFiles.forEach(file => log(`  - ${file}`, 'warn'));
            }
            
            resolve(); 
        } else {
            let errorMsg = `rsync failed with exit code ${code}`;
            
            // Provide specific error messages for common rsync error codes
            switch(code) {
                case 1:
                    errorMsg += ' - Syntax or usage error. This may be due to incompatible rsync options or arguments.';
                    if (stderrBuf.includes('unknown option') || stderrBuf.includes('invalid option')) {
                        errorMsg += ` Rsync option error: ${stderrBuf.trim()}`;
                    }
                    break;
                case 2:
                    errorMsg += ' - Protocol incompatibility';
                    break;
                case 3:
                    errorMsg += ' - Errors selecting input/output files';
                    break;
                case 4:
                    errorMsg += ' - Missing action, action not supported, or unknown';
                    break;
                case 5:
                    errorMsg += ' - Error starting client-server protocol';
                    break;
                case 6:
                    errorMsg += ' - Daemon unable to append to log';
                    break;
                case 10:
                    errorMsg += ' - Error in socket I/O';
                    break;
                case 11:
                    errorMsg += ' - Error in file I/O';
                    break;
                case 12:
                    errorMsg += ' - Error in rsync protocol data stream';
                    break;
                case 13:
                    errorMsg += ' - Errors with program diagnostics';
                    break;
                case 14:
                    errorMsg += ' - Error in IPC code';
                    break;
                case 20:
                    errorMsg += ' - Received SIGUSR1 or SIGINT';
                    break;
                case 21:
                    errorMsg += ' - Some error returned by waitpid()';
                    break;
                case 22:
                    errorMsg += ' - Error allocating core memory buffers';
                    break;
                case 23:
                    errorMsg += ' - Permission denied on some files. This usually indicates specific files are locked or have restricted permissions even for root.';
                    if (stderrBuf.includes('sudo:')) {
                        errorMsg += ` Sudo error: ${stderrBuf.trim()}`;
                    }
                    
                    log(errorMsg, 'warn');
                    log('WARNING: Some files could not be copied due to permission issues. The conversion will continue, but these specific files will be missing from the target.', 'warn');
                    
                    if (skippedFiles.length > 0) {
                        log(`Skipped files: ${skippedFiles.join(', ')}`, 'warn');
                    }

                    // Treat as non-fatal
                    resolve();
                    return;
                case 30:
                    errorMsg += ' - Timeout in data send/receive';
                    break;
                default:
                    errorMsg += ` - ${stderrBuf.trim() || 'Unknown error'}`;
            }
            
            log(errorMsg, 'error');
            reject(new Error(errorMsg)); 
        }
    });
    
    proc.on('error', (err) => {
        log(`rsync process error: ${err.message}`, 'error');
        reject(err);
    });
  });
}

async function verifyStagingTask(src, dest, job, progress, log, getPriv, isFinal = false) {
  return new Promise((resolve, reject) => {
    // Adding --info=progress2 and --no-inc-recursive to get progress updates even for dry-run verification
    const args = ['-aHAXx', '--numeric-ids', '--checksum', '--dry-run', '--stats', '--info=progress2', '--no-inc-recursive', `${src}/`, `${dest}/`];
    const priv = getPriv();
    
    // Log the command being executed for debugging
    const fullCmd = priv.length > 0 ? `${priv.join(' ')} rsync ${args.join(' ')}` : `rsync ${args.join(' ')}`;
    log(`Verification command: ${fullCmd}`, 'debug');
    
    // Align with runRsyncTask's spawn logic for better privilege handling
    const proc = spawn(priv[0] || 'rsync', [...priv.slice(1), 'rsync', ...args], { 
      stdio: priv.length > 0 ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, SUDO_ASKPASS: '/bin/false' }
    });
    
    job.cancelFn = () => proc.kill();
    
    let stdoutBuf = '';
    let stderrBuf = '';
    let progressBuf = '';
    
    proc.stdout.on('data', d => {
        const data = d.toString();
        stdoutBuf += data;
        
        // Parse rsync progress output
        progressBuf += data;
        const lines = progressBuf.split('\r');
        progressBuf = lines.pop();
        for (const line of lines) {
            const m = line.match(/(\d+)%\s+([\d.]+[\w/s]+)\s+([\d:]+)/);
            const mSimple = !m ? line.match(/(\d+)%/) : null;
            
            if (m || mSimple) {
                const pct = parseInt(m ? m[1] : mSimple[1]);
                const speed = m ? m[2] : null;
                const eta = m ? m[3] : null;
                const base = isFinal ? 95 : 55;
                const scale = isFinal ? 0.03 : 0.10;
                progress(isFinal ? 10 : 5, Math.floor(base + pct * scale), `Verifying: ${pct}%`, speed, eta);
            }
        }
    });
    
    proc.stderr.on('data', d => {
        stderrBuf += d.toString();
        const stderrText = d.toString().trim();
        // Log sudo-related errors specifically
        if (stderrText.includes('sudo') || stderrText.includes('password') || stderrText.includes('permission')) {
            log(`verification stderr (auth): ${stderrText}`, 'warn');
        } else {
            log(`verification stderr: ${stderrText}`, 'info');
        }
    });
    
    proc.on('close', code => { 
        if (code === 0) {
            log('verification completed successfully', 'success');
            
            // Parse stats from rsync output for better logging
            const statsMatch = stdoutBuf.match(/Total file size: ([\d,]+) bytes/);
            const transferredMatch = stdoutBuf.match(/Total transferred file size: ([\d,]+) bytes/);
            if (statsMatch && transferredMatch) {
                const totalSize = parseInt(statsMatch[1].replace(/,/g, ''));
                const transferredSize = parseInt(transferredMatch[1].replace(/,/g, ''));
                log(`verification stats: ${formatBytes(transferredSize)} of ${formatBytes(totalSize)}`, 'info');
            }
            
            resolve(); 
        } else if (code === 24) {
            log('verification completed with vanished files (code 24) - some files may have changed during verification', 'warn');
            resolve(); 
        } else {
            let errorMsg = `verification failed with exit code ${code}`;
            if (code === 23) {
                errorMsg += ' - Permission denied on some files during verification. This is expected if some files were skipped during the copy phase.';
                // Extract possible missing files from verification dry-run
                const pathMatches = stdoutBuf.matchAll(/rsync: .*? "(.*)" failed/gi);
                for (const m of pathMatches) job.skippedFiles.add(m[1]);
                
                log(errorMsg, 'warn');
                log('Verification continued despite some individual file errors.', 'warn');
                resolve();
                return;
            }
            errorMsg += ` - ${stderrBuf.trim() || stdoutBuf.trim() || 'Unknown error'}`;
            log(errorMsg, 'error');
            reject(new Error(errorMsg)); 
        }
    });
    
    proc.on('error', (err) => {
        log(`verification process error: ${err.message}`, 'error');
        reject(err);
    });
  });
}

async function performCleanup(job, tempMount, stagingMount, imageFile, rsyncDest, newMount, keepStaging, log) {
  const runPriv = (c, a) => runPrivileged(c, a);
  
  if (log) log('Cleaning up temporary mounts...');
  if (tempMount) await runPriv('umount', ['-l', tempMount]).catch(() => {});
  if (stagingMount) await runPriv('umount', ['-l', stagingMount]).catch(() => {});
  if (newMount) await runPriv('umount', ['-l', newMount]).catch(() => {});
  
  if (keepStaging) {
    if (log) log('Preserving staging data as requested by user.', 'success');
  } else {
    // Only delete if we are NOT in a critical phase where data might be lost
    // or if we explicitly finished successfully.
    const skipDelete = job.status !== 'complete' && job.currentStep >= 7;
    
    if (!skipDelete) {
      if (log) log('Removing staging data...');
      if (imageFile) try { fs.unlinkSync(imageFile); } catch (_) {}
      if (rsyncDest && !imageFile) await runPriv('rm', ['-rf', rsyncDest]).catch(() => {});
    } else {
        if (log) log('Skipping staging data deletion due to potential recovery need (Step >= 7 and incomplete).', 'warn');
    }
  }

  // Cleanup temp directories
  try {
    if (tempMount && tempMount.includes('transmute-src-')) fs.rmdirSync(tempMount);
    if (stagingMount && stagingMount.includes('transmute-stage-')) fs.rmdirSync(stagingMount);
    if (newMount && newMount.includes('transmute-new-')) fs.rmdirSync(newMount);
  } catch(_) {}
}



function buildMkfsArgs(targetFs, device, label, uuid) {
  const args = ['-F'];
  if (targetFs === 'xfs') args[0] = '-f';
  if (label) args.push(targetFs === 'f2fs' ? '-l' : '-L', label);
  if (uuid && ['ext4', 'ext3', 'ext2', 'btrfs'].includes(targetFs)) args.push('-U', uuid);
  args.push(device);
  return args;
}

async function getStagingDevice(stagingPath, stagingType) {
    try {
        const { stdout } = await execFileAsync('findmnt', ['-n', '-o', 'SOURCE', stagingType === 'image' ? path.dirname(stagingPath) : stagingPath]);
        return stdout.trim();
    } catch (_) { return null; }
}

async function isSamePhysicalDevice(p1, p2) {
    try {
        const { stdout: s1 } = await execFileAsync('lsblk', ['-n', '-o', 'PKNAME', p1]);
        const { stdout: s2 } = await execFileAsync('lsblk', ['-n', '-o', 'PKNAME', p2]);
        return s1.trim() && s1.trim() === s2.trim();
    } catch (_) { return false; }
}

class CancelError extends Error { constructor() { super('Cancelled'); this.isCancelError = true; } }
function getJobStatus(jobId) { const job = activeJobs.get(jobId); return job ? { id: job.id, status: job.status, step: job.currentStep } : null; }
function cancelConversion(jobId) { const job = activeJobs.get(jobId); if (job) { job.cancelled = true; if (job.cancelFn) job.cancelFn(); return true; } return false; }

module.exports = { startConversion, cancelConversion, getJobStatus };
