# Transmute ⇄
### Non-destructive filesystem converter for Linux

Convert drive filesystems (NTFS → ext4, ext4 → XFS, etc.) **without losing your data** using a checksummed rsync-based staging pipeline.

---

Transmute has currently only been extensively tested on Nobara/Fedora. I am doing testing on more distros and will update the officially supported distro list below 
as I know more. 

## How it works

Transmute never touches your data destructively until it has verified a complete, checksummed copy exists elsewhere:

```
1. Mount source read-only
2. rsync all data → staging location (external drive / image file / directory)
3. Verify staging checksum (rsync --checksum --dry-run)
4. Unmount source
5. mkfs to target filesystem
6. Mount new filesystem
7. rsync data back from staging
8. Verify restored data matches
9. Update /etc/fstab with new UUID
10. Clean up staging
```

---

## Requirements

### Node.js 18+
```bash
# Nobara / Fedora
sudo dnf install nodejs

# Or use nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
```

### System tools (required)
```bash
sudo dnf install rsync parted util-linux
```

### Filesystem tools (install what you need)
```bash
# For ext2/3/4 support
sudo dnf install e2fsprogs

# For XFS support
sudo dnf install xfsprogs

# For Btrfs support
sudo dnf install btrfs-progs

# For F2FS support
sudo dnf install f2fs-tools

# For FAT32/exFAT support
sudo dnf install dosfstools exfatprogs

# For NTFS read/write and formatting
sudo dnf install ntfs-3g

# Install all at once:
sudo dnf install e2fsprogs xfsprogs btrfs-progs f2fs-tools dosfstools exfatprogs ntfs-3g
```

---

## Installation & Running

```bash
# Extract the archive, then:
cd transmute
chmod +x run.sh
chmod +x install.sh
./run.sh to run
./install.sh to install
```
---

## Privilege escalation

Transmute shells out to `parted`, `mkfs.*`, `mount`, `umount`, etc. — these require root.

- If you have **pkexec** (polkit) installed, Transmute uses it (GUI password prompt)
- If you have **sudo** with `NOPASSWD` configured, it uses that
- You can also launch Transmute as root: `sudo npx electron .`

For best experience on Nobara/Fedora, pkexec is already available via polkit.

---

## Staging requirements

You need a staging location with **at least 110% of your source data size** free:

| Method | Use case |
|--------|----------|
| External drive / mount | Best — another physical drive |
| Disk image (.img) | If you have a large directory on another partition |
| Custom directory | Any writable path on a different partition |

**Never use the same physical drive as source for staging** — if the drive fails during conversion, you lose everything.

---

## Supported conversions

| From \ To | ext4 | ext3 | xfs | btrfs | f2fs | ntfs | exfat | vfat |
|-----------|------|------|-----|-------|------|------|-------|------|
| ntfs      | ✓    | ✓    | ✓   | ✓     | ✓    | —    | ✓     | ✓    |
| ext4      | —    | ✓    | ✓   | ✓     | ✓    | ✓    | ✓     | ✓    |
| xfs       | ✓    | ✓    | —   | ✓     | ✓    | ✓    | ✓     | ✓    |
| btrfs     | ✓    | ✓    | ✓   | —     | ✓    | ✓    | ✓     | ✓    |
| exfat     | ✓    | ✓    | ✓   | ✓     | ✓    | ✓    | —     | ✓    |
| vfat/fat32| ✓    | ✓    | ✓   | ✓     | ✓    | ✓    | ✓     | —    |

---

## Important notes

- System partitions (`/`, `/boot`, `/usr`) are detected and blocked — boot from a live USB to convert those
- Encrypted partitions (LUKS) are not supported — decrypt first
- LVM volumes should work if they appear as block devices, but are untested currently
- Swap partitions are not convertible (they have no filesystem)
- It is recommended to maintain an **independent backup** before any filesystem operation. Transmute was created with data safety in mind and has been tested extensively on my own drives and data, but it is better to be safe than sorry.
- There is an option for transmute to keep the staging data (not clean it up on conversion completion). 
- This serves as a secondary full data backup. If anything feels off after the conversion, your data is still sitting in the staging file ready to be restored manually or via the Recovery tab.
- In the event of a failure, Transmute ships with a disk recovery utility baked in. You can use this to restore your data from a staging data file (in the event a conversion fails, for example). 
- The disk recovery can also be used to restore a corrupted drive that was not caused by Transmute using the Metadata Archeology option. This option is not perfect, but I am working on improving it.
- `/etc/fstab` is updated automatically with the new UUID — a backup is saved to `/etc/fstab.transmute.bak`

## Officially Supported Distros

- Nobara/Fedora

---
