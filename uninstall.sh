#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Transmute — Uninstall Script
# Completely removes Transmute from the system.
# ─────────────────────────────────────────────────────────────────────────────

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${RED}╔══════════════════════════════════════╗${NC}"
echo -e "${RED}║      Transmute — Uninstallation      ║${NC}"
echo -e "${RED}╚══════════════════════════════════════╝${NC}"

INSTALL_DIR="/opt/transmute"
BIN_PATH="/usr/local/bin/transmute"
DESKTOP_PATH="/usr/share/applications/transmute.desktop"
ICON_PATH_1="/usr/share/icons/hicolor/256x256/apps/transmute.png"
ICON_PATH_2="/usr/share/icons/hicolor/scalable/apps/transmute.png"

echo -e "\n${YELLOW}Removing files (requires sudo)...${NC}"

# Remove binary
if [ -f "$BIN_PATH" ]; then
    echo -e "Removing $BIN_PATH"
    sudo rm "$BIN_PATH"
fi

# Remove desktop entry
if [ -f "$DESKTOP_PATH" ]; then
    echo -e "Removing $DESKTOP_PATH"
    sudo rm "$DESKTOP_PATH"
fi

# Remove icons
if [ -f "$ICON_PATH_1" ]; then
    echo -e "Removing $ICON_PATH_1"
    sudo rm "$ICON_PATH_1"
fi
if [ -f "$ICON_PATH_2" ]; then
    echo -e "Removing $ICON_PATH_2"
    sudo rm "$ICON_PATH_2"
fi

# Remove installation directory
if [ -d "$INSTALL_DIR" ]; then
    echo -e "Removing $INSTALL_DIR"
    sudo rm -rf "$INSTALL_DIR"
fi

# Update databases
echo -e "${YELLOW}Updating system databases...${NC}"
sudo update-desktop-database /usr/share/applications || true
sudo gtk-update-icon-cache /usr/share/icons/hicolor || true

echo -e "\n${GREEN}✓ Transmute has been successfully uninstalled.${NC}"
