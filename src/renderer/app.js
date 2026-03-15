'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   TRANSMUTE — Renderer Process
   All UI state, rendering, and IPC communication lives here.
══════════════════════════════════════════════════════════════════════════ */

const api = window.transmute;

// ── App state ─────────────────────────────────────────────────────────────
const state = {
  view: 'convert',
  theme: 'dark',
  drives: [],           // raw lsblk tree
  flatDrives: [],       // flattened partition list
  driveDetails: {},     // { path: { used, usedHuman, ... } }
  deps: null,
  stagingLocations: [],

  // Convert wizard
  selectedPartition: null,
  targetFs: null,
  stagingType: 'directory',
  stagingPath: '',
  customStagingPath: '',
  preserveUuid: true,
  newLabel: '',
  stagingValidation: null,
  keepStaging: false,

  // Active conversion
  activeJob: null,
  jobProgress: { pct: 0, step: 0, detail: '' },
  jobLogs: [],
  jobSteps: [],

  history: [],

  // Recovery & Archeology
  recoveryAssets: [],
  recoveryLoading: false,
  recoveryTarget: '',
  recoveryAsset: '',
  archTarget: '',
  archFindings: null,
  archScanning: false
};

const CONV_STEPS = [
  'Pre-flight checks',
  'Checking mount status',
  'Mounting source read-only',
  'Setting up staging area',
  'Copying data to staging',
  'Verifying staging integrity',
  'Unmounting source partition',
  'Formatting to target filesystem',
  'Mounting new filesystem',
  'Restoring data from staging',
  'Verifying restored data',
  'Updating fstab & cleanup',
];

const FS_OPTIONS = [
  { id: 'ext4',  name: 'ext4',  desc: 'Linux standard',    recommend: true },
  { id: 'xfs',   name: 'xfs',   desc: 'High performance'   },
  { id: 'btrfs', name: 'btrfs', desc: 'Snapshots + CoW'    },
  { id: 'f2fs',  name: 'f2fs',  desc: 'Flash-optimized'    },
  { id: 'ntfs',  name: 'ntfs',  desc: 'Windows compat'     },
  { id: 'exfat', name: 'exfat', desc: 'Cross-platform'     },
];

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  initWindowControls();
  initTheme();
  initSidebarToggle();
  initNav();

  // Load history count immediately
  loadHistory();

  // Scan drives
  await scanDrives();

  // Check deps in background
  checkDeps();

  // Load staging locations
  loadStagingLocations();

  // Register conversion events
  api.on('conversion-progress', handleProgress);
  api.on('conversion-log', handleLog);
  api.on('conversion-complete', handleComplete);
  api.on('conversion-error', handleError);

  render();
}

// ── Window controls ────────────────────────────────────────────────────────
function initWindowControls() {
  document.getElementById('btnMin').addEventListener('click', () => api.minimize());
  document.getElementById('btnMax').addEventListener('click', () => api.maximize());
  document.getElementById('btnClose').addEventListener('click', () => api.close());
}

// ── Theme ──────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('transmute-theme') || 'dark';
  setTheme(saved);
  document.getElementById('themeToggle').addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });
}

function setTheme(t) {
  state.theme = t;
  document.body.setAttribute('data-theme', t);
  localStorage.setItem('transmute-theme', t);
  const icon = document.getElementById('themeIcon');
  if (t === 'dark') {
    icon.innerHTML = `<circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.9 11.9l1.05 1.05M11.9 4.11l1.05-1.06M3.05 12.95l1.06-1.06" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
  } else {
    icon.innerHTML = `<path d="M12.5 8.5A4.5 4.5 0 0 1 6 3a5.5 5.5 0 1 0 6.5 5.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`;
  }
}

function initSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sidebarToggle');
  const saved = localStorage.getItem('transmute-sidebar-collapsed') === 'true';
  if (saved) sidebar.classList.add('collapsed');

  btn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('transmute-sidebar-collapsed', sidebar.classList.contains('collapsed'));
  });
}

// ── Nav ────────────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  document.getElementById('scanBtn').addEventListener('click', () => scanDrives());
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === v);
  });
  render();
  if (v === 'recovery') scanRecoveryAssets();
}

// ── Data loading ───────────────────────────────────────────────────────────
async function scanDrives() {
  document.getElementById('sidebarDrives').innerHTML = '<div class="sidebar-loading"><span class="spin">↻</span> Scanning…</div>';
  const res = await api.scanDrives();
  if (!res.ok) { showToast('Drive scan failed: ' + res.error, 'error'); return; }

  state.drives = res.drives || [];
  state.flatDrives = flattenDrives(state.drives);

  // Fetch usage details
  await Promise.all(
    state.flatDrives
      .filter(d => d.fstype && (d.type === 'part' || (d.type === 'disk' && !d.children?.length)))
      .map(async d => {
        const r = await api.getDriveDetails(d.path);
        if (r.ok) state.driveDetails[d.path] = r.details;
      })
  );

  renderSidebar();
  render();
}

function flattenDrives(devTree) {
  const out = [];
  function walk(dev) {
    out.push(dev);
    if (dev.children) dev.children.forEach(walk);
  }
  devTree.forEach(walk);
  return out;
}

async function checkDeps() {
  const res = await api.checkDependencies();
  if (!res.ok) return;
  state.deps = res.deps;

  const dot = document.getElementById('depStatusDot');
  if (!dot) return;
  if (!state.deps.ok) {
    dot.className = 'dep-status error';
    showToast('Missing required tools. See Dependencies tab.', 'warn');
  } else if (state.deps.availableTargets.length < 3) {
    dot.className = 'dep-status warn';
  } else {
    dot.className = 'dep-status ok';
  }
}

async function loadStagingLocations() {
  const res = await api.getStagingLocations();
  if (res.ok) state.stagingLocations = res.locations;
}

async function scanRecoveryAssets() {
  state.recoveryLoading = true;
  render();
  const res = await api.scanRecoveryStaging();
  state.recoveryLoading = false;
  if (res.ok) {
    state.recoveryAssets = res.candidates;
    // Attempt to auto-match with current history/drives
    state.recoveryAssets.forEach(asset => {
      const match = state.history.find(h => h.status === 'error' && (asset.path.includes(h.jobId) || asset.name.includes(h.jobId)));
      if (match) asset.historyMatch = match;
    });
  }
  render();
}

async function loadHistory() {
  const res = await api.getHistory();
  if (res.ok) {
    state.history = res.history;
    const badge = document.getElementById('historyBadge');
    if (badge) badge.textContent = state.history.length;
  }
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById('sidebarDrives');
  const parts = state.flatDrives.filter(d => d.type === 'part' || (d.type === 'disk' && !d.children?.length));

  if (!parts.length) {
    el.innerHTML = '<div class="sidebar-loading">No partitions found</div>';
    return;
  }

  el.innerHTML = parts.map(d => `
    <div class="sidebar-drive-item ${state.selectedPartition?.path === d.path ? 'selected-for-conv' : ''}"
         data-path="${d.path}" onclick="sidebarSelectDrive('${d.path}')"
         title="${escapeHtml(d.friendlyName || d.name || d.path)}">
      <svg class="nav-icon" viewBox="0 0 16 16" fill="none">${driveIconSvg(d)}</svg>
      <span class="sdi-name">${d.friendlyName ? escapeHtml(d.friendlyName) + ' · ' : ''}${d.name || d.path}</span>
      <span class="sdi-fs">${fsBadge(d.fstype)}</span>
    </div>
  `).join('');
}

function sidebarSelectDrive(path) {
  const d = state.flatDrives.find(x => x.path === path);
  if (!d) return;
  if (state.view !== 'convert') setView('convert');
  selectPartition(d);
}

// ── Render dispatcher ──────────────────────────────────────────────────────
function render() {
  const mc = document.getElementById('mainContent');
  if (state.activeJob) {
    mc.innerHTML = renderConvertProgress();
    setupProgressListeners();
    return;
  }
  switch (state.view) {
    case 'convert':  mc.innerHTML = renderConvertView();  setupConvertListeners();  break;
    case 'analyze':  mc.innerHTML = renderAnalyzeView();  break;
    case 'recovery': mc.innerHTML = renderRecoveryView(); setupRecoveryListeners(); break;
    case 'history':  mc.innerHTML = renderHistoryView();  setupHistoryListeners();  break;
    case 'deps':     mc.innerHTML = renderDepsView();     break;
    default:         mc.innerHTML = renderConvertView();  setupConvertListeners();
  }
}

// ── Convert view ───────────────────────────────────────────────────────────
function renderConvertView() {
  const partitions = state.flatDrives.filter(d => d.type === 'part' || (d.type === 'disk' && d.fstype));
  const sel = state.selectedPartition;

  // If a modal is open, we want to refresh its content
  if (sel && !document.getElementById('wizardModal').hidden) {
    updateWizardContent();
  }

  return `
    <div class="page-header">
      <div class="page-title">Convert Filesystem</div>
      <div class="page-sub">non-destructive · rsync-based staging · data preserved throughout</div>
    </div>

    <!-- Step 1: Select partition -->
    <div class="section-label">
      <span class="section-num active">1</span>
      Select Partition
    </div>
    <div class="drives-list" id="drivesList">
      ${partitions.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">⊙</div><div class="empty-state-text">No partitions detected</div><div class="empty-state-sub">Try rescanning or check that drives are connected</div></div>' : ''}
      ${partitions.map(d => renderDriveCard(d)).join('')}
    </div>

    <div class="empty-state" style="padding: 40px 0; border-top: 1px solid var(--border); margin-top: 30px;">
      <div class="empty-state-icon">↑</div>
      <div class="empty-state-text">Select a partition above to begin</div>
    </div>
  `;
}

function updateWizardContent() {
  const container = document.getElementById('wizardContent');
  if (!container) return;
  
  // To prevent losing focus on inputs while typing, we save the active element and its cursor position
  const activeId = document.activeElement ? document.activeElement.id : null;
  const start = document.activeElement ? document.activeElement.selectionStart : null;
  const end = document.activeElement ? document.activeElement.selectionEnd : null;

  container.innerHTML = renderWizardModalContent();

  // Restore focus if needed
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.focus();
      // Only set selection if it's a text input
      if (start !== null && (el.type === 'text' || el.tagName === 'INPUT')) {
        try { el.setSelectionRange(start, end); } catch(_) {}
      }
    }
  }
}

function renderWizardModalContent() {
  const sel = state.selectedPartition;
  if (!sel) return '';
  const selDet = state.driveDetails[sel.path] || {};

  const step2Done = !!state.targetFs;
  const step3Done = step2Done && !!state.stagingPath;
  const canConvert = step2Done && step3Done && state.stagingValidation?.valid;

  const isBitLocker = sel.fstype?.toLowerCase().includes('bitlocker') || selDet.error?.toLowerCase().includes('bitlocker');

  return `
    <div class="modal-header">
      <div class="modal-title">Configure Conversion</div>
      <div class="modal-subtitle" style="font-size: 13px; color: var(--text-2);">
        ${sel.friendlyName || sel.name} (${sel.path}) · ${sel.sizeHuman}
      </div>
    </div>

    <div class="modal-scroll-area">
    ${sel.isSystem ? `
      <div class="alert alert-danger" style="margin-top:20px; margin-bottom: 20px;">
        <div class="alert-icon">⊗</div>
        <div class="alert-body">
          <div class="alert-title">System partition — cannot convert</div>
          <div class="alert-text">This partition contains your OS. Boot from a live USB (Nobara Live, GParted Live) to convert it safely.</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-full" onclick="closeWizard()">Cancel</button>
    ` : isBitLocker ? `
      <div class="alert alert-danger" style="margin-top:20px; margin-bottom: 20px;">
        <div class="alert-icon">⊗</div>
        <div class="alert-body">
          <div class="alert-title">BitLocker encrypted</div>
          <div class="alert-text">Conversion of encrypted drives is not yet supported. Decrypt the drive in Windows first.</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-full" onclick="closeWizard()">Cancel</button>
    ` : `
    <div style="padding-top:20px"></div>
    <!-- Step 2: Target filesystem -->
    <div class="section-label">
      <span class="section-num ${step2Done ? 'done' : 'active'}">2</span>
      Target Filesystem
      <span style="font-size:10px;color:var(--text-2);font-family:var(--font-mono);margin-left:4px;">currently ${fsBadge(sel.fstype)}</span>
    </div>

    <div class="fs-grid" id="fsGrid" style="margin-bottom: 24px;">
      ${FS_OPTIONS.map(f => {
        const isCurrent = f.id === sel.fstype || (f.id === 'ntfs' && sel.fstype === 'ntfs-3g');
        const unavailable = state.deps && !state.deps.availableTargets.includes(f.id);
        const isSelected = state.targetFs === f.id;
        return `<div class="fs-opt ${isSelected ? 'selected' : ''} ${isCurrent ? 'current' : ''} ${unavailable && !isCurrent ? 'unavailable' : ''}"
          data-fs="${f.id}"
          ${isCurrent || (unavailable) ? '' : `onclick="selectFs('${f.id}')"`}
          title="${unavailable ? 'mkfs.' + f.id + ' not found' : isCurrent ? 'Already this filesystem' : ''}">
          ${f.recommend ? `<span class="fs-opt-tag">recommended</span>` : ''}
          <div class="fs-opt-name">${f.name}</div>
          <div class="fs-opt-desc">${isCurrent ? '(current)' : unavailable ? 'not installed' : f.desc}</div>
        </div>`;
      }).join('')}
    </div>

    <!-- Step 3: Staging -->
    <div class="section-label">
      <span class="section-num ${step3Done ? 'done' : step2Done ? 'active' : ''}">3</span>
      Staging Location
      <span style="font-size:10px;color:var(--text-2);font-family:var(--font-mono);margin-left:4px;">need ≥ ${selDet.usedHuman || '?'} free</span>
    </div>

    <div class="staging-list" id="stagingList" style="margin-bottom: 24px;">
      ${renderStagingOptions(selDet.used || 0)}
    </div>

    <!-- Step 4: Options -->
    <div class="section-label">
      <span class="section-num">4</span>
      Options
    </div>

    ${(() => {
      const srcFs = (sel.fstype || '').toLowerCase();
      const tgtFs = (state.targetFs || '').toLowerCase();
      const isNtfsInvolved = srcFs.includes('ntfs') || tgtFs.includes('ntfs');
      
      return `
      <div class="options-row" style="margin-bottom: 24px;">
        <div class="option-check ${isNtfsInvolved ? 'disabled-opt' : ''}">
          <input type="checkbox" id="chkUuid" ${state.preserveUuid && !isNtfsInvolved ? 'checked' : ''} 
                 ${isNtfsInvolved ? 'disabled' : ''} 
                 onchange="state.preserveUuid=this.checked">
          <label for="chkUuid" style="${isNtfsInvolved ? 'color: var(--text-3); cursor: not-allowed;' : ''}">
            Preserve UUID (update fstab)
            ${isNtfsInvolved ? `<span style="font-size: 10px; display: block; margin-top: 4px; color: var(--danger); font-weight: 600;">
              ${srcFs.includes('ntfs') ? 'Source' : 'Target'} NTFS does not support persistent UUID due to different format
            </span>` : ''}
          </label>
        </div>
        <div class="label-input-row" style="flex: 1; display: flex; align-items: center; gap: 8px;">
          <label style="white-space:nowrap; font-size: 11px;">New label</label>
          <input type="text" id="labelInput" placeholder="optional" maxlength="32"
            style="background: var(--bg-0); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; color: var(--text-0); flex: 1;"
            value="${state.newLabel || ''}"
            oninput="state.newLabel=this.value">
        </div>
      </div>

      <div class="options-row" style="margin-bottom: 24px;">
        <div class="option-check">
           <input type="checkbox" id="chkKeepStaging" ${state.keepStaging ? 'checked' : ''} onchange="state.keepStaging=this.checked">
           <label for="chkKeepStaging">
             Keep staging data (backup)
             <span style="font-size: 10px; display: block; margin-top: 4px; color: var(--text-3);">
               The staging data will NOT be deleted after success, allowing it to double as a full data backup.
             </span>
           </label>
        </div>
      </div>

      ${isNtfsInvolved ? `
      <div class="alert alert-info" style="margin-bottom: 20px;">
        <div class="alert-icon">ℹ</div>
        <div class="alert-body">
          <div class="alert-text" style="font-size: 11px;">
            <strong>NTFS UUID Restriction:</strong> NTFS uses non-standard 64-bit serial numbers. 
            Uuid preservation is impossible when ${srcFs.includes('ntfs') ? 'migrating from' : 'converting to'} NTFS. 
            Transmute will generate ${srcFs.includes('ntfs') ? 'a new UUID' : 'a compatible serial'} automatically.
          </div>
        </div>
      </div>
      ` : ''}`;
    })()}

    <!-- Warning -->
    <div class="alert alert-warn" style="margin-bottom: 20px;">
      <div class="alert-icon">⚠</div>
      <div class="alert-body">
        <div class="alert-text" style="font-size: 11px;">Transmute uses checksummed staging, but hardware failures are possible. <strong>Ensure you have a separate backup.</strong></div>
      </div>
    </div>

    <!-- Start Button -->
    <button class="btn btn-primary btn-full btn-lg" id="startBtn" ${canConvert ? '' : 'disabled'}
      onclick="confirmAndStart()">
      ${!step2Done ? 'Select target filesystem' :
        !step3Done ? 'Select staging location' :
        state.stagingValidation && !state.stagingValidation.valid ? (state.stagingValidation.error || 'Staging validation failed') :
        `⇄ Start Conversion`}
    </button>
    `}
    </div>
  `;
}

function openWizard() {
  const modal = document.getElementById('wizardModal');
  updateWizardContent();
  modal.hidden = false;
}

function closeWizard() {
  const modal = document.getElementById('wizardModal');
  modal.hidden = true;
  state.selectedPartition = null;
  render();
}

function renderDriveCard(d) {
  const det = state.driveDetails[d.path] || {};
  const isSelected = state.selectedPartition?.path === d.path;
  const isSystem = d.isSystem;
  const usedPct = det.usedPercent || 0;
  const fillClass = usedPct > 90 ? 'danger' : usedPct > 75 ? 'warn' : '';
  // det.usedHuman is null when NTFS usage couldn't be determined
  const usageUnknown = det.unknown || (det.usedHuman === null && Object.keys(det).length > 0);
  const usedLabel = usageUnknown ? '—' : (det.usedHuman || (Object.keys(det).length ? '—' : '…'));
  const friendlyName = d.friendlyName || d.model || null;

  return `
    <div class="drive-card ${isSelected ? 'selected' : ''} ${isSystem ? 'system-drive' : ''}"
      data-path="${d.path}"
      onclick="${isSystem ? '' : `selectPartition_byPath('${d.path}')`}"
      title="${isSystem ? 'System partition — cannot convert while booted' : d.convertibleReason || ''}">
      <div class="drive-card-top">
        <div class="drive-type-icon">
          <svg viewBox="0 0 20 20" fill="none">${driveIconSvgLg(d)}</svg>
        </div>
        <div class="drive-meta-col">
          ${friendlyName ? `<div class="drive-friendly">${escapeHtml(friendlyName)}</div>` : ''}
          <div class="drive-name ${friendlyName ? 'drive-name-sub' : ''}">${d.name || d.path}${d.label ? ' — ' + d.label : ''}</div>
          <div class="drive-path">${d.path}${d.mountpoint ? ' → ' + d.mountpoint : ''}</div>
        </div>
        <div class="drive-badges">
          ${fsBadge(d.fstype)}
          ${isSystem ? '<span class="badge badge-system">OS</span>' : ''}
          ${d.driveClass === 'nvme' ? '<span class="badge badge-nvme">NVMe</span>' : ''}
          ${d.hotplug ? '<span class="badge badge-usb">USB</span>' : ''}
          ${d.readonly ? '<span class="badge badge-ro">R/O</span>' : ''}
        </div>
      </div>
      <div class="drive-card-bottom">
        <div class="usage-track">
          <div class="usage-fill ${fillClass}" style="width:${usedPct}%"></div>
        </div>
        <div class="usage-row">
          <span>${usedLabel} used${det.usedHuman ? ' of ' + d.sizeHuman : (usageUnknown ? '' : ' of ' + d.sizeHuman)}</span>
          <span>${usageUnknown ? '—' : usedPct + '%'}</span>
        </div>
      </div>
    </div>`;
}

function renderStagingOptions(requiredBytes) {
  const locs = state.stagingLocations;

  // Custom path option always appears
  const rows = [];

  // Auto-detected locations
  for (const loc of locs) {
    const sufficient = loc.available >= requiredBytes * 1.1;
    const isSelected = state.stagingType === 'directory' && state.stagingPath === loc.path;
    rows.push(`
      <div class="staging-opt ${isSelected ? 'selected' : ''}"
        onclick="selectStaging('directory', '${loc.path}')">
        <div class="staging-radio"></div>
        <div class="staging-opt-body">
          <div class="staging-opt-label">${loc.label}</div>
          <div class="staging-opt-sub">${loc.description} · ${loc.availableHuman} free</div>
          <div class="staging-opt-avail ${sufficient ? 'ok' : 'error'}">
            ${sufficient ? '✓ Sufficient space' : `⚠ Need ${formatBytes(Math.ceil(requiredBytes * 1.1))}, have ${loc.availableHuman}`}
          </div>
        </div>
      </div>`);
  }

  // Disk image option
  const imgSelected = state.stagingType === 'image';
  rows.push(`
    <div class="staging-opt ${imgSelected ? 'selected' : ''}"
      onclick="selectStaging('image', '')">
      <div class="staging-radio"></div>
      <div class="staging-opt-body">
        <div class="staging-opt-label">Disk Image File (.img)</div>
        <div class="staging-opt-sub">Create a sparse image on another volume, then restore from it</div>
        ${imgSelected ? `
        <div class="staging-path-input">
          <input type="text" id="imgPathInput" placeholder="/mnt/external/transmute-stage.img"
            value="${state.customStagingPath}"
            oninput="updateCustomPath(this.value)"
            onchange="validateStagingNow()">
          <button class="browse-btn" onclick="browseImagePath()">Browse</button>
        </div>
        ${state.stagingValidation ? `<div class="staging-opt-avail ${state.stagingValidation.valid ? 'ok' : 'error'}" style="margin-top:4px;">
          ${state.stagingValidation.valid ? '✓ ' + state.stagingValidation.availableHuman + ' available' : '✗ ' + state.stagingValidation.error}
        </div>` : ''}
        ` : ''}
      </div>
    </div>`);

  // Custom directory option
  const customDirSelected = state.stagingType === 'customdir';
  rows.push(`
    <div class="staging-opt ${customDirSelected ? 'selected' : ''}"
      onclick="selectStaging('customdir', '')">
      <div class="staging-radio"></div>
      <div class="staging-opt-body">
        <div class="staging-opt-label">Custom Directory</div>
        <div class="staging-opt-sub">Specify any writable directory on another mount</div>
        ${customDirSelected ? `
        <div class="staging-path-input">
          <input type="text" id="customDirInput" placeholder="/mnt/external"
            value="${state.customStagingPath}"
            oninput="updateCustomPath(this.value)"
            onchange="validateStagingNow()">
          <button class="browse-btn" onclick="browseCustomDir()">Browse</button>
        </div>
        ${state.stagingValidation ? `<div class="staging-opt-avail ${state.stagingValidation.valid ? 'ok' : 'error'}" style="margin-top:4px;">
          ${state.stagingValidation.valid ? '✓ ' + state.stagingValidation.availableHuman + ' available' : '✗ ' + state.stagingValidation.error}
        </div>` : ''}
        ` : ''}
      </div>
    </div>`);

  return rows.join('');
}

// ── Convert listeners ──────────────────────────────────────────────────────
function setupConvertListeners() {
  // Drive card clicks are handled by inline onclick in renderDriveCard
  // to prevent duplicate binding issues when the DOM is rebuilt.
}

function selectPartition_byPath(path) {
  const d = state.flatDrives.find(x => x.path === path);
  if (d) selectPartition(d);
}

function selectPartition(d) {
  state.selectedPartition = d;
  state.targetFs = null;
  state.stagingPath = null;
  state.stagingValidation = null;

  // Force UUID preservation OFF if source is NTFS
  if ((d.fstype || '').toLowerCase().includes('ntfs')) {
    state.preserveUuid = false;
  } else {
    state.preserveUuid = true;
  }

  renderSidebar();
  render();

  if (d) {
    openWizard();
  }
}

function selectFs(id) {
  console.log(`[DEBUG] selectFs called with: ${id}`);
  state.targetFs = id;
  
  // Force UUID preservation OFF if target is NTFS
  const srcFs = (state.selectedPartition?.fstype || '').toLowerCase();
  if (id === 'ntfs' || srcFs.includes('ntfs')) {
    console.log('[DEBUG] NTFS involved, forcing UUID preservation OFF');
    state.preserveUuid = false;
  }

  console.log(`[DEBUG] state.targetFs: ${state.targetFs}, state.preserveUuid: ${state.preserveUuid}`);
  updateWizardContent();
}

async function selectStaging(type, path) {
  state.stagingType = type;
  state.stagingPath = path;
  state.customStagingPath = path;
  state.stagingValidation = { valid: false, error: 'Validating…' };
  updateWizardContent();

  if (path && state.selectedPartition) {
    const det = state.driveDetails[state.selectedPartition.path] || {};
    try {
      const res = await api.validateStaging({ 
        stagingType: type === 'image' ? 'image' : 'directory', 
        stagingPath: path, 
        requiredBytes: det.used || 0 
      });
      if (res && res.ok) {
        state.stagingValidation = res.result;
      } else {
        state.stagingValidation = { valid: false, error: res?.error || 'Validation failed' };
      }
    } catch (err) {
      state.stagingValidation = { valid: false, error: 'Validation process crashed' };
    }
  }
  updateWizardContent();
}

function updateCustomPath(val) {
  state.customStagingPath = val;
  state.stagingPath = val;
}

async function validateStagingNow() {
  if (!state.customStagingPath || !state.selectedPartition) return;
  const det = state.driveDetails[state.selectedPartition.path] || {};
  const type = state.stagingType === 'image' ? 'image' : 'directory';
  state.stagingValidation = { valid: false, error: 'Validating…' };
  updateWizardContent();
  try {
    await validateStaging(type, state.customStagingPath, det.used || 0);
  } catch (err) {
    state.stagingValidation = { valid: false, error: 'Validation failed' };
  }
  updateWizardContent();
}

async function validateStaging(type, path, requiredBytes) {
  const res = await api.validateStaging({ stagingType: type, stagingPath: path, requiredBytes });
  if (res && res.ok) {
    state.stagingValidation = res.result;
  } else {
    state.stagingValidation = { valid: false, error: res?.error || 'Validation failed' };
  }
}

async function browseImagePath() {
  const res = await api.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose directory for disk image'
  });
  if (!res.canceled && res.filePaths[0]) {
    const dir = res.filePaths[0];
    const imgPath = dir + '/transmute-stage.img';
    state.customStagingPath = imgPath;
    state.stagingPath = imgPath;
    const input = document.getElementById('imgPathInput');
    if (input) input.value = imgPath;
    await validateStagingNow();
  }
}

async function browseCustomDir() {
  const res = await api.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose staging directory'
  });
  if (!res.canceled && res.filePaths[0]) {
    state.customStagingPath = res.filePaths[0];
    state.stagingPath = res.filePaths[0];
    document.getElementById('customDirInput').value = res.filePaths[0];
    await validateStagingNow();
    updateWizardContent();
  }
}

// ── Confirm and start ──────────────────────────────────────────────────────
async function confirmAndStart() {
  const sel = state.selectedPartition;
  if (!sel || !state.targetFs) return;

  // Close the configuration modal before showing confirmation
  document.getElementById('wizardModal').hidden = true;

  const confirm = await showConfirmModal({
    icon: '⇄',
    title: 'Begin Conversion?',
    body: `Convert <strong>${sel.path}</strong> from <strong>${sel.fstype}</strong> to <strong>${state.targetFs}</strong>.<br><br>
      Data will be preserved via rsync staging at <code>${state.stagingPath}</code>.<br><br>
      <div class="alert alert-info" style="margin-top:14px; margin-bottom:0;">
        <div class="alert-icon">ℹ</div>
        <div class="alert-body">
          <div class="alert-text"><strong>Please be patient.</strong> This process involves moving all your data to a staging area and back. It can take anywhere from a few minutes to several hours depending on your drive speed and data size.</div>
        </div>
      </div>
      <br>Do <strong>not</strong> unplug any drives or power off during conversion.`,
    confirmLabel: 'Start Conversion',
    confirmClass: 'btn-primary'
  });

  if (confirm) {
    startConversion();
  }
}

async function startConversion(optsOverride = null) {
  const sel = optsOverride ? { path: optsOverride.sourcePath } : state.selectedPartition;
  
  state.activeJob = { id: null, status: 'starting' };
  state.jobProgress = { pct: 0, step: 0, detail: 'Starting…' };
  state.jobLogs = [];
  
  if (!optsOverride) document.getElementById('wizardModal').hidden = true;
  
  render();

  const finalOpts = optsOverride || {
    sourcePath: sel.path,
    sourceFs: state.selectedPartition.fstype,
    targetFs: state.targetFs,
    stagingType: state.stagingType === 'customdir' ? 'directory' : state.stagingType,
    stagingPath: state.stagingPath,
    newLabel: state.newLabel || state.selectedPartition.label || null,
    preserveUuid: state.preserveUuid,
    keepStaging: state.keepStaging
  };

  const res = await api.startConversion(finalOpts);

  if (!res.ok) {
    state.activeJob = null;
    showToast('Failed to start: ' + res.error, 'error');
    render();
    return;
  }

  state.activeJob = { id: res.jobId, status: 'running', sourcePath: sel.path, sourceFs: sel.fstype };
  state.targetFs = finalOpts.targetFs;
  render();
}

// ── Progress handling ──────────────────────────────────────────────────────
function handleProgress(data) {
  state.jobProgress = { 
    pct: data.pct, 
    step: data.step, 
    detail: data.detail,
    speed: data.speed,
    eta: data.eta
  };
  updateProgressUI();
}

function handleLog(data) {
  console.log(`[RENDERER] Received log: ${data.msg}`); // Debug log
  const ts = new Date(data.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.jobLogs.push({ msg: data.msg, level: data.level, ts });
  if (state.jobLogs.length > 200) state.jobLogs.shift();
  updateLogUI();
}

function handleComplete(data) {
  state.activeJob = null;
  loadHistory().then(() => {
    scanDrives();
    showToast(`✓ Conversion complete — ${data.sourcePath} is now ${data.targetFs}`, 'success');
    state.selectedPartition = null;
    state.targetFs = null;
    state.stagingPath = '';
    state.stagingValidation = null;
    setView('history');
  });
}

function handleError(data) {
  state.activeJob = null;
  if (data.cancelled) {
    showToast('Conversion cancelled', 'warn');
  } else {
    showToast('Conversion failed: ' + data.error, 'error');
    // Ensure history is updated and shown
    loadHistory().then(() => {
      setView('history');
    });
  }
  render();
}

// ── Progress view ──────────────────────────────────────────────────────────
function renderConvertProgress() {
  const job = state.activeJob;
  const prog = state.jobProgress;
  const pct = prog.pct || 0;
  const currentStep = prog.step || 0;

  const stepsHtml = CONV_STEPS.map((label, i) => {
    let cls = 'pending';
    let icon = String(i + 1);
    if (i < currentStep) { cls = 'done'; icon = '✓'; }
    else if (i === currentStep) { cls = 'running'; icon = '<span class="spin">◌</span>'; }
    return `<div class="step-row ${cls}">
      <div class="step-indicator">${icon}</div>
      <div class="step-label">${label}</div>
      ${i === currentStep && prog.detail ? `<div class="step-detail">${prog.detail}</div>` : ''}
    </div>`;
  }).join('');

  const logsHtml = state.jobLogs.map(l =>
    `<div class="log-line ${l.level}"><span class="log-timestamp">${l.ts}</span>${escapeHtml(l.msg)}</div>`
  ).join('');

  return `
    <div class="page-header">
      <div class="page-title">Converting…</div>
      <div class="page-sub">do not unmount drives or power off the system</div>
    </div>

    <div class="progress-header-card">
      <div class="progress-meta">
        <div>
          <div class="progress-drive-name">${job?.sourcePath || ''}</div>
          <div class="progress-route">
            ${fsBadge(job?.sourceFs)}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${fsBadge(state.targetFs)}
          </div>
        </div>
        <div class="progress-pct-col" style="text-align: right;">
          <div class="progress-pct-large">${pct}%</div>
          ${prog.eta ? `<div class="progress-eta-top">ETA: ${prog.eta}${prog.speed ? ` · ${prog.speed}` : ''}</div>` : ''}
        </div>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="progressFill" style="width:${pct}%"></div>
      </div>
      <div class="steps-grid" id="stepsGrid">${stepsHtml}</div>
    </div>

    <div class="log-card">
      <div class="log-header">
        <span class="log-title">Live Log</span>
        <button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;" onclick="clearLogs()">Clear</button>
      </div>
      <div class="log-scroll" id="logScroll">${logsHtml}</div>
    </div>

    <button class="btn btn-danger" style="width:100%;" onclick="cancelConversion()">
      Cancel Conversion
    </button>`;
}

function setupProgressListeners() {}

function updateProgressUI() {
  const pct = state.jobProgress.pct || 0;
  const currentStep = state.jobProgress.step || 0;
  const detail = state.jobProgress.detail || '';

  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = pct + '%';

  const pctEl = document.querySelector('.progress-pct-large');
  if (pctEl) pctEl.textContent = pct + '%';

  const pctCol = document.querySelector('.progress-pct-col');
  if (pctCol) {
    const etaHtml = state.jobProgress.eta ? `<div class="progress-eta-top">ETA: ${state.jobProgress.eta}${state.jobProgress.speed ? ` · ${state.jobProgress.speed}` : ''}</div>` : '';
    const existingEta = pctCol.querySelector('.progress-eta-top');
    if (existingEta) {
      if (etaHtml) existingEta.outerHTML = etaHtml;
      else existingEta.remove();
    } else if (etaHtml) {
      pctCol.insertAdjacentHTML('beforeend', etaHtml);
    }
  }

  const stepsGrid = document.getElementById('stepsGrid');
  if (stepsGrid) {
    stepsGrid.innerHTML = CONV_STEPS.map((label, i) => {
      let cls = 'pending';
      let icon = String(i + 1);
      if (i < currentStep) { cls = 'done'; icon = '✓'; }
      else if (i === currentStep) { cls = 'running'; icon = '<span class="spin">◌</span>'; }
      return `<div class="step-row ${cls}">
        <div class="step-indicator">${icon}</div>
        <div class="step-label">${label}</div>
        ${i === currentStep && detail ? `<div class="step-detail">${detail}</div>` : ''}
      </div>`;
    }).join('');
  }
}

function updateLogUI() {
  const el = document.getElementById('logScroll');
  if (!el) return;
  const logsHtml = state.jobLogs.map(l =>
    `<div class="log-line ${l.level}"><span class="log-timestamp">${l.ts}</span>${escapeHtml(l.msg)}</div>`
  ).join('');
  el.innerHTML = logsHtml;
  el.scrollTop = el.scrollHeight;
}

function clearLogs() {
  state.jobLogs = [];
  updateLogUI();
}

async function cancelConversion() {
  if (!state.activeJob?.id) return;
  const confirm = await showConfirmModal({
    icon: '⚠',
    title: 'Cancel Conversion?',
    body: 'The conversion will be stopped. Your source data should remain intact on the original filesystem, but verify before use.',
    confirmLabel: 'Cancel Conversion',
    confirmClass: 'btn-danger'
  });

  if (confirm) {
    await api.cancelConversion(state.activeJob.id);
  }
}

// ── Analyze view ───────────────────────────────────────────────────────────
function renderAnalyzeView() {
  const parts = state.flatDrives.filter(d => d.type === 'part' || (d.type === 'disk' && d.fstype));

  if (!parts.length) return `
    <div class="page-header">
      <div class="page-title">Analyze Drives</div>
      <div class="page-sub">filesystem health &amp; compatibility</div>
    </div>
    <div class="empty-state"><div class="empty-state-icon">⊙</div><div class="empty-state-text">No partitions found</div></div>`;

  const cards = parts.map(d => {
    const det = state.driveDetails[d.path] || {};
    const usedPct = det.usedPercent || 0;
    const fillClass = usedPct > 90 ? 'danger' : usedPct > 75 ? 'warn' : '';
    const isLinuxNative = ['ext2','ext3','ext4','xfs','btrfs','f2fs'].includes(d.fstype);
    const canConvert = d.convertible;

    const analyzeDetFriendly = d.friendlyName || d.model || null;
    return `
      <div class="analyze-card">
        <div class="analyze-card-header">
          <div class="drive-type-icon">
            <svg viewBox="0 0 20 20" fill="none" width="20" height="20">${driveIconSvgLg(d)}</svg>
          </div>
          <div class="analyze-meta">
            ${analyzeDetFriendly ? `<div class="analyze-friendly">${escapeHtml(analyzeDetFriendly)}</div>` : ''}
            <div class="analyze-name ${analyzeDetFriendly ? 'analyze-name-sub' : ''}">${d.name || d.path}${d.label ? ' — ' + d.label : ''}</div>
            <div class="analyze-path">${d.path}${d.uuid ? ' · UUID: ' + d.uuid : ''}</div>
          </div>
          <div class="drive-badges">
            ${fsBadge(d.fstype)}
            ${d.isSystem ? '<span class="badge badge-system">system</span>' : ''}
            ${d.driveClass === 'nvme' ? '<span class="badge badge-nvme">NVMe</span>' : ''}
            ${d.hotplug ? '<span class="badge badge-usb">USB</span>' : ''}
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Size</div>
            <div class="stat-val">${d.sizeHuman}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Used</div>
            <div class="stat-val ${usedPct > 90 ? 'danger' : usedPct > 75 ? 'warn' : ''}">${det.usedHuman || '?'}</div>
            <div class="stat-sub">${usedPct}%</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Linux Native</div>
            <div class="stat-val ${isLinuxNative ? 'ok' : 'warn'}">${isLinuxNative ? 'Yes' : 'No'}</div>
            <div class="stat-sub">${isLinuxNative ? 'Full support' : 'Driver required'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Convertible</div>
            <div class="stat-val ${canConvert ? 'ok' : 'danger'}">${canConvert ? 'Yes' : 'No'}</div>
            <div class="stat-sub" style="word-break:break-word;">${d.convertibleReason || 'All checks passed'}</div>
          </div>
        </div>

        <div class="usage-track" style="margin-bottom:8px;">
          <div class="usage-fill ${fillClass}" style="width:${usedPct}%"></div>
        </div>

        <div class="compat-row">
          <span>Compatibility:</span>
          ${buildCompatChips(d.fstype)}
        </div>
        ${d.mountpoints?.filter(m=>m).length ? `<div style="margin-top:6px;font-size:11px;color:var(--text-2);font-family:var(--font-mono);">Mounted at: ${d.mountpoints.filter(m=>m).join(', ')}</div>` : ''}
      </div>`;
  });

  return `
    <div class="page-header">
      <div class="page-title">Analyze Drives</div>
      <div class="page-sub">filesystem health &amp; compatibility report</div>
    </div>
    ${cards.join('')}`;
}

function buildCompatChips(fstype) {
  const compat = {
    'ext4':   { Linux: true,  Windows: false, macOS: false, Android: true  },
    'ext3':   { Linux: true,  Windows: false, macOS: false, Android: true  },
    'ext2':   { Linux: true,  Windows: false, macOS: false, Android: true  },
    'xfs':    { Linux: true,  Windows: false, macOS: false, Android: false },
    'btrfs':  { Linux: true,  Windows: false, macOS: false, Android: false },
    'f2fs':   { Linux: true,  Windows: false, macOS: false, Android: true  },
    'ntfs':   { Linux: true,  Windows: true,  macOS: true,  Android: false },
    'ntfs-3g':{ Linux: true,  Windows: true,  macOS: true,  Android: false },
    'exfat':  { Linux: true,  Windows: true,  macOS: true,  Android: true  },
    'vfat':   { Linux: true,  Windows: true,  macOS: true,  Android: true  },
    'fat32':  { Linux: true,  Windows: true,  macOS: true,  Android: true  },
  };
  const map = compat[fstype] || {};
  return Object.entries(map).map(([os, supported]) =>
    `<span class="compat-chip ${supported ? '' : 'no'}">${os}</span>`
  ).join('');
}

// ── History view ───────────────────────────────────────────────────────────
function renderHistoryView() {
  return `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;">
      <div>
        <div class="page-title">Conversion History</div>
        <div class="page-sub">${state.history.length} operation${state.history.length !== 1 ? 's' : ''} recorded</div>
      </div>
      ${state.history.length > 0 ? `<button class="btn btn-ghost" id="clearHistBtn" style="margin-top:2px;">Clear All</button>` : ''}
    </div>

    ${state.history.length === 0 ? `
      <div class="empty-state">
        <div class="empty-state-icon">☰</div>
        <div class="empty-state-text">No conversions yet</div>
        <div class="empty-state-sub">Completed conversions will appear here</div>
      </div>` :
      state.history.map(h => `
        <div class="history-item" style="flex-direction:column;align-items:stretch;gap:8px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div class="history-icon ${h.status}">
              ${h.status === 'success' ? '✓' : '✗'}
            </div>
            <div class="history-meta">
              <div class="history-name">${h.sourcePath || 'Unknown device'}</div>
              <div class="history-date">${new Date(h.date).toLocaleString()}</div>
            </div>
            <div class="history-route">
              ${fsBadge(h.sourceFs)}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              ${fsBadge(h.targetFs)}
              <span class="badge ${h.status === 'success' ? 'badge-ext4' : 'badge-ro'}">${h.status}</span>
              ${h.duration ? `<span style="font-size:10px;color:var(--text-2);font-family:var(--font-mono);">${h.duration}s</span>` : ''}
            </div>
          </div>
          ${h.error ? `<div class="history-error-box">${escapeHtml(h.error)}</div>` : ''}
          ${h.skippedFilesLog ? `
            <div style="margin-top:4px;">
              <button class="btn-link" onclick="showSkippedFiles('${h.skippedFilesLog.replace(/\\/g, '/')}')" 
                      style="background:none; border:none; color:var(--warn); font-size:11px; cursor:pointer; padding:0; font-weight:600; text-decoration:underline;">
                ⚠ See skipped files
              </button>
            </div>
          ` : ''}
        </div>`).join('')}`;
}

async function setupHistoryListeners() {
  const btn = document.getElementById('clearHistBtn');
  if (btn) btn.addEventListener('click', async () => {
    const confirm = await showConfirmModal({
      icon: '🗑',
      title: 'Clear History?',
      body: 'This will remove all conversion history records. The actual drive data is not affected.',
      confirmLabel: 'Clear History',
      confirmClass: 'btn-danger'
    });

    if (confirm) {
      await api.clearHistory();
      await loadHistory();
      render();
    }
  });
}

// ── Dependencies view ──────────────────────────────────────────────────────
function renderDepsView() {
  if (!state.deps) {
    return `
      <div class="page-header"><div class="page-title">Dependencies</div></div>
      <div class="empty-state"><div class="empty-state-icon"><span class="spin">↻</span></div><div class="empty-state-text">Checking dependencies…</div></div>`;
  }

  const d = state.deps;

  const reqRows = d.required.map(t => `
    <div class="dep-row ${t.available ? '' : 'missing'}">
      <div class="dep-indicator ${t.available ? 'ok' : 'missing'}"></div>
      <div class="dep-name">${t.name}</div>
      <div class="dep-purpose">${t.purpose}</div>
      <div class="dep-status-text ${t.available ? 'ok' : 'missing'}">${t.available ? 'found' : 'missing'}</div>
    </div>`).join('');

  const optRows = d.optional.map(t => `
    <div class="dep-row">
      <div class="dep-indicator ${t.available ? 'ok' : 'missing'}"></div>
      <div class="dep-name">${t.name}</div>
      <div class="dep-purpose">${t.purpose}</div>
      <div class="dep-status-text ${t.available ? 'ok' : 'missing'}">${t.available ? 'found' : 'not found'}</div>
    </div>`).join('');

  const installHtml = d.installHints.length > 0 ? `
    <div class="install-box">
      <div class="install-box-title">Install missing packages</div>
      ${d.installHints.map(h => `
        <div class="install-distro">Fedora / Nobara (DNF)</div>
        <div class="install-cmd">${escapeHtml(h.fedora)}</div>
        <div class="install-distro">Debian / Ubuntu (APT)</div>
        <div class="install-cmd">${escapeHtml(h.debian)}</div>
        <div class="install-distro">Arch (Pacman)</div>
        <div class="install-cmd">${escapeHtml(h.arch)}</div>
      `).join('')}
    </div>` : '';

  return `
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;">
      <div>
        <div class="page-title">Dependencies</div>
        <div class="page-sub">system tools required for conversion</div>
      </div>
      <button class="btn btn-ghost" onclick="recheckDeps()" style="margin-top:2px;">Re-check</button>
    </div>

    ${d.ok ? `
      <div class="alert alert-success" style="margin-bottom:14px;">
        <div class="alert-icon">✓</div>
        <div class="alert-body">
          <div class="alert-title" style="color:var(--success)">All required tools found</div>
          <div class="alert-text" style="color:var(--success);">Privilege method: ${d.isRoot ? 'running as root' : d.privMethod || 'none — conversion requires root'}</div>
        </div>
      </div>` : `
      <div class="alert alert-danger" style="margin-bottom:14px;">
        <div class="alert-icon">⊗</div>
        <div class="alert-body">
          <div class="alert-title" style="color:var(--danger)">Missing required tools</div>
          <div class="alert-text" style="color:var(--danger);">Install the packages below, then re-check.</div>
        </div>
      </div>`}

    <div class="section-label">Required</div>
    <div class="deps-grid">${reqRows}</div>

    <div class="section-label" style="margin-top:18px;">Optional (filesystem support)</div>
    <div class="deps-grid">${optRows}</div>

    <div class="section-label" style="margin-top:18px;">Available conversion targets</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
      ${FS_OPTIONS.map(f =>
        `<span class="badge ${d.availableTargets.includes(f.id) ? 'badge-' + f.id : 'badge-system'}">${f.name}</span>`
      ).join('')}
    </div>

    ${installHtml}`;
}

async function recheckDeps() {
  state.deps = null;
  if (state.view === 'deps') render();
  await checkDeps();
  if (state.view === 'deps') render();
}

// ── Modal ──────────────────────────────────────────────────────────────────
function showConfirmModal({ icon = '⚠', title = 'Confirm', body, message, confirmLabel = 'Proceed', confirmClass = 'btn-primary' }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmModal');
    const iconEl = document.getElementById('modalIcon');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');

    iconEl.textContent = icon;
    titleEl.textContent = title;
    
    let content = body || message || '';
    bodyEl.innerHTML = content;

    const cleanup = () => {
      overlay.hidden = true;
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    };

    confirmBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    overlay.hidden = false;
  });
}

// Global modal handling
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('confirmModal').hidden = true;
    closeWizard();
  }
});

// Outside click for wizard
document.getElementById('wizardModal').onclick = (e) => {
  if (e.target.id === 'wizardModal') closeWizard();
};

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-dot"></div><span>${escapeHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastIn 0.2s ease reverse';
    setTimeout(() => toast.remove(), 200);
  }, type === 'error' ? 10000 : 3500);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fsBadge(fstype) {
  if (!fstype) return '<span class="badge badge-system">none</span>';
  const cls = fstype.replace('-', '');
  return `<span class="badge badge-${cls}">${fstype}</span>`;
}

function driveIconSvg(d) {
  if (d.driveClass === 'hdd') {
    return `<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor" opacity="0.5"/>`;
  } else if (d.hotplug) {
    return `<rect x="4" y="3" width="8" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M6 6h4M6 9h4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>`;
  } else {
    return `<rect x="2" y="5" width="12" height="6" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="11" cy="8" r="1" fill="currentColor"/>`;
  }
}

function driveIconSvgLg(d) {
  if (d.driveClass === 'hdd') {
    return `<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.5" fill="currentColor" opacity="0.4"/><circle cx="10" cy="4" r="1" fill="currentColor" opacity="0.3"/>`;
  } else if (d.hotplug) {
    return `<rect x="5" y="3" width="10" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M7 7h6M7 11h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`;
  } else {
    return `<rect x="2" y="6" width="16" height="8" rx="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="10" r="1.5" fill="currentColor" opacity="0.5"/><path d="M4 9h7M4 11h5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>`;
  }
}

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  const v = b / Math.pow(1024, i);
  return `${v % 1 === 0 ? v : v.toFixed(1)} ${u[Math.min(i, u.length - 1)]}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Expose some functions globally for inline onclick handlers
window.selectPartition_byPath = selectPartition_byPath;
window.sidebarSelectDrive = sidebarSelectDrive;
window.selectFs = selectFs;
window.selectStaging = selectStaging;
window.updateCustomPath = updateCustomPath;
window.validateStagingNow = validateStagingNow;
window.browseImagePath = browseImagePath;
window.browseCustomDir = browseCustomDir;
window.confirmAndStart = confirmAndStart;
window.cancelConversion = cancelConversion;
window.clearLogs = clearLogs;
window.recheckDeps = recheckDeps;
window.showSkippedFiles = (path) => api.showSkippedFiles(path);
window.state = state;

// ── Start ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

// ── Recovery View ──────────────────────────────────────────────────────────
// ── Recovery View ──────────────────────────────────────────
function renderRecoveryView() {
  const assets = state.recoveryAssets || [];
  const brokenDrives = state.flatDrives.filter(d => !d.fstype && (d.type === 'part' || d.type === 'disk'));

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">Disk Recovery</h1>
        <p class="view-subtitle">Non-destructive Archeology & Resume Staging Operations</p>
      </div>
      <button class="btn btn-ghost" onclick="scanRecoveryAssets()">
        <span class="icon">↻</span> Rescan Staging
      </button>
    </div>

    <div class="recovery-grid">
      <!-- Section A: Transmute Staging Recovery -->
      <div class="recovery-card">
        <h3 class="recovery-card-title">Resume Transmute Task</h3>
        <p class="recovery-card-desc">Restore a partition using existing Transmute staging data.</p>
        
        <div class="recovery-section-box">
          <label class="field-label">1. Target Partition</label>
          <select id="stagingTarget" class="recovery-select" onchange="state.recoveryTarget=this.value; state.recoveryAsset=''; render();">
            <option value="">Select unformatted drive...</option>
            ${brokenDrives.map(d => `<option value="${d.path}" ${state.recoveryTarget === d.path ? 'selected' : ''}>${d.path} (${d.sizeHuman})</option>`).join('')}
          </select>
        </div>

        <div class="recovery-section-box ${!state.recoveryTarget ? 'disabled-section' : ''}">
          <div class="section-label-row" style="display:flex; justify-content:space-between; align-items:center;">
            <label class="field-label" style="margin-bottom:0;">2. Staging Data</label>
            <button class="btn-link" onclick="manualBrowseRecoveryAsset()" ${!state.recoveryTarget ? 'disabled' : ''} style="background:none; border:none; color:var(--accent); font-size:11px; cursor:pointer; padding:0; font-weight:600;">Browse Manually...</button>
          </div>
          <div class="staging-asset-list">
            ${!state.recoveryTarget ? `<div class="empty-mini">Select a drive first</div>` :
              (() => {
                const relevant = assets.filter(a => 
                  !state.recoveryTarget || 
                  (a.historyMatch && a.historyMatch.sourcePath === state.recoveryTarget) ||
                  a.path.includes(state.recoveryTarget.replace('/dev/', ''))
                );
                
                if (relevant.length === 0) return `
                  <div class="empty-mini">
                    No matching staging found.
                    <p style="font-size:10px;margin-top:4px;color:var(--text-3);">If you can't find it, use <b>Metadata Archeology</b> instead.</p>
                  </div>
                `;
                
                return relevant.map(a => `
                  <div class="asset-item ${state.recoveryAsset === a.path ? 'active' : ''}" onclick="selectRecoveryAsset('${a.path}')">
                    <span class="asset-icon">${a.type === 'image' ? '💿' : '📁'}</span>
                    <div class="asset-meta">
                      <div class="asset-name">${a.name}</div>
                      <div class="asset-path" title="${a.path}">${a.path}</div>
                      ${a.historyMatch ? `<div class="asset-tag" style="font-size:9px; color:var(--success); font-weight:700; margin-top:2px;">MATCHED FROM HISTORY</div>` : ''}
                    </div>
                  </div>
                `).join('');
              })()
            }
          </div>
        </div>

        <button class="btn btn-primary btn-full" ${!state.recoveryTarget || !state.recoveryAsset ? 'disabled' : ''} onclick="initiateStagingRecovery()">
          Restore from Staging
        </button>
      </div>

      <!-- Section B: Novel Disk Archeology (The "Bulletproof" Path) -->
      <div class="recovery-card archeology-card">
        <h3 class="recovery-card-title">Metadata Archeology</h3>
        <p class="recovery-card-desc">Deep-scan any broken drive to identify lost filesystems and rescue data in-place.</p>

        <div class="recovery-section-box">
          <label class="field-label">Select Corrupted Drive</label>
          <div class="drive-archeology-select">
             <select id="archTarget" class="recovery-select" onchange="state.archTarget=this.value; state.archFindings=null; render();">
                <option value="">Select drive to scan...</option>
                ${state.flatDrives.map(d => `<option value="${d.path}" ${state.archTarget === d.path ? 'selected' : ''}>${d.path} [${d.fstype || 'unrecognized'}]</option>`).join('')}
             </select>
             <button class="btn btn-secondary" ${!state.archTarget ? 'disabled' : ''} onclick="probeArcheology()">
                ${state.archScanning ? '<span class="spin">↻</span> Probing...' : 'Deep Probe'}
             </button>
          </div>
        </div>

        ${state.archFindings && state.archFindings.length > 0 ? `
          <div class="findings-box">
            <div class="findings-title">Archeological Findings:</div>
            <div class="findings-list">
              ${state.archFindings.map(f => `
                <div class="finding-item">
                  <div class="finding-header">
                    <span class="finding-type">${f.type || 'Signature'}</span>
                    <span class="finding-method">${f.method} @ ${f.offset || 'Header'}</span>
                  </div>
                  <div class="finding-stats">
                    ${f.inaccessible ? `<span style="color:var(--error)">⚠️ Structure Inaccessible</span>` : `
                      ${f.fileCount !== undefined ? `<span>📄 ${f.fileCount} files</span>` : ''}
                      ${f.folderCount !== undefined ? `<span>📁 ${f.folderCount} folders</span>` : ''}
                    `}
                  </div>
                  <div class="finding-note">${f.note || ''}</div>
                </div>
              `).join('')}
            </div>
            
            <div class="rescue-action">
                 <button class="btn btn-primary btn-full" onclick="initiateArcheologyRescue()">
                    Atomic Rescue & Reconstruction
                 </button>
            </div>
          </div>
        ` : state.archFindings ? `
          <div class="findings-box">
            <div class="findings-title">Archeological Findings:</div>
            <div class="empty-archeology" style="padding:20px; text-align:center;">
              <div class="empty-icon" style="font-size:24px;">🚫</div>
              <p style="font-size:12px; margin-top:8px;">No forensic traces found. The disk metadata may be completely zeroed or encrypted.</p>
            </div>
          </div>
        ` : state.archScanning ? `
          <div class="archeology-loading">
             <div class="scan-bar"><div class="scan-progress"></div></div>
             <p>Scanning blocks for filesystem headers...</p>
          </div>
        ` : `
          <div class="empty-archeology">
            <div class="empty-icon">🔎</div>
            <p>Select a drive and click "Deep Probe" to begin archeological reconstruction.</p>
          </div>
        `}
      </div>
    </div>
  `;
}

function selectRecoveryAsset(path) {
  state.recoveryAsset = path;
  render();
}

async function probeArcheology() {
  if (!state.archTarget) return;
  state.archScanning = true;
  state.archFindings = null;
  render();
  
  const res = await api.probeArcheology(state.archTarget);
  state.archScanning = false;
  if (res.ok) {
    state.archFindings = res.findings;
  } else {
    showToast('Probe failed: ' + res.error, 'error');
  }
  render();
}

async function initiateStagingRecovery() {
  const targetFs = 'ext4'; 
  const sourcePath = state.recoveryTarget;
  const stagingPath = state.recoveryAsset;
  
  const confirm = await showConfirmModal({
    title: 'Confirm Staging Recovery',
    body: `Restore ${sourcePath} from staging ${stagingPath}? Data on ${sourcePath} will be overwritten.`,
    confirmLabel: 'Start Recovery'
  });

  if (!confirm) return;

  const asset = state.recoveryAssets.find(a => a.path === stagingPath);
  startConversion({ 
    sourcePath, targetFs, stagingPath, 
    stagingType: asset ? asset.type : 'directory',
    isRecovery: true 
  });
}

async function initiateArcheologyRescue() {
  const devicePath = state.archTarget;
  
  // Implicitly determine the filesystem from findings
  const bestFinding = state.archFindings.find(f => f.type && f.confidence === 'high') || 
                      state.archFindings.find(f => f.type) || 
                      { type: 'ext4' };
  
  const targetFs = bestFinding.type;

  const confirm = await showConfirmModal({
    title: 'Atomic Rescue & Reconstruction',
    body: `Transmute has identified a <strong>${targetFs}</strong> structure. We will attempt to virtually mount ${devicePath}, format it securely as ${targetFs}, and stream the identified data back.<br><br>This preserves original data while fixing the corrupted partition.`,
    confirmLabel: 'Start Rescue'
  });

  if (!confirm) return;
  
  showToast('Starting Atomic Rescue...', 'info');
  
  const res = await api.performArcheologyRecovery({ devicePath, targetFs });
  if (res.ok) {
    showToast('Virtual Mount Successful! Migrating data...', 'success');
    startConversion({
       sourcePath: devicePath,
       targetFs,
       stagingPath: res.mountPoint,
       stagingType: 'directory',
       isRecovery: true
    });
  } else {
    showToast('Rescue failed: ' + res.error, 'error');
  }
}

async function manualBrowseRecoveryAsset() {
  const res = await api.showOpenDialog({
    title: 'Select Staging Image or Directory',
    properties: ['openFile', 'openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return;
  
  const path = res.filePaths[0];
  const validation = await api.validateRecoveryStaging(path);
  
  if (validation.ok) {
    const name = path.split('/').pop();
    const newAsset = { 
        path, 
        name, 
        type: validation.result.type,
        size: validation.result.size || 0
    };
    if (!state.recoveryAssets) state.recoveryAssets = [];
    state.recoveryAssets.push(newAsset);
    state.recoveryAsset = path;
    showToast(`Staging data added: ${name}`, 'success');
  } else {
    showToast('Invalid staging data: ' + validation.error, 'error');
  }
  render();
}

function setupRecoveryListeners() {}

// Add global bindings
window.scanRecoveryAssets = scanRecoveryAssets;
window.selectRecoveryAsset = selectRecoveryAsset;
window.manualBrowseRecoveryAsset = manualBrowseRecoveryAsset;
window.probeArcheology = probeArcheology;
window.initiateStagingRecovery = initiateStagingRecovery;
window.initiateArcheologyRescue = initiateArcheologyRescue;
