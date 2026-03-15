#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Transmute — Install & Launch Script
# Run this from the transmute directory after extracting the archive.
# ─────────────────────────────────────────────────────────────────────────────

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║        Transmute — Setup              ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# Check Node
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install via: sudo dnf install nodejs${NC}"
  exit 1
fi
NODE_VER=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo -e "${RED}✗ Node.js 18+ required (found $(node --version))${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# Check npm
if ! command -v npm &>/dev/null; then
  echo -e "${RED}✗ npm not found${NC}"
  exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

# Install dependencies
echo ""
echo -e "${YELLOW}Installing npm dependencies…${NC}"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --prefer-offline 2>/dev/null || npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# Download Electron binary if not present
echo ""
echo -e "${YELLOW}Checking Electron binary…${NC}"
if node -e "require('electron')" &>/dev/null 2>&1; then
  ELECTRON_PATH=$(node -e "process.stdout.write(require('electron'))")
  if [ -f "$ELECTRON_PATH" ]; then
    echo -e "${GREEN}✓ Electron binary found at $ELECTRON_PATH${NC}"
  else
    echo -e "${YELLOW}Downloading Electron binary (this may take a moment)…${NC}"
    npx electron --version || node node_modules/electron/install.js
  fi
else
  echo -e "${YELLOW}Downloading Electron binary…${NC}"
  node node_modules/electron/install.js
fi

# Check system tools
echo ""
echo -e "${YELLOW}Checking system tools…${NC}"
MISSING_REQ=()
MISSING_OPT=()

check_tool() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $1"
  else
    if [ "$2" = "required" ]; then
      echo -e "  ${RED}✗${NC} $1 (REQUIRED)"
      MISSING_REQ+=("$1")
    else
      echo -e "  ${YELLOW}○${NC} $1 (optional)"
      MISSING_OPT+=("$1")
    fi
  fi
}

echo "Required:"
check_tool rsync required
check_tool lsblk required
check_tool blkid required
check_tool findmnt required
check_tool parted required
check_tool mount required

echo "Filesystem tools:"
check_tool mkfs.ext4 optional
check_tool mkfs.xfs optional
check_tool mkfs.btrfs optional
check_tool mkfs.f2fs optional
check_tool mkfs.vfat optional
check_tool mkfs.exfat optional
check_tool ntfs-3g optional

if [ ${#MISSING_REQ[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}Missing required tools: ${MISSING_REQ[*]}${NC}"
  echo -e "${YELLOW}Install with: sudo dnf install rsync parted util-linux${NC}"
  echo ""
fi

if [ ${#MISSING_OPT[@]} -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}Install optional filesystem tools for full target support:${NC}"
  echo -e "  sudo dnf install e2fsprogs xfsprogs btrfs-progs f2fs-tools dosfstools exfatprogs ntfs-3g"
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════${NC}"

if [ ${#MISSING_REQ[@]} -gt 0 ]; then
  echo -e "${RED}Cannot start: install required tools first${NC}"
  exit 1
fi

echo -e "${GREEN}Starting Transmute…${NC}"
echo ""

# Launch (needs to be run as root or with sudo/pkexec for disk operations)
if [ "$EUID" -eq 0 ]; then
  echo -e "${YELLOW}Note: running as root${NC}"
  npx electron .
else
  echo -e "${YELLOW}Note: disk operations require root. Transmute will use pkexec/sudo for privileged commands.${NC}"
  echo -e "${YELLOW}If prompted for your password, this is normal.${NC}"
  echo ""
  npx electron .
fi
