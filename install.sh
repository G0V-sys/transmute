#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Transmute — Install Script
# Automatically configures Transmute as a first-class Linux application.
# ─────────────────────────────────────────────────────────────────────────────

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      Transmute — Installation        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"

# 1. Path Setup
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/transmute"
BIN_PATH="/usr/local/bin/transmute"
DESKTOP_PATH="/usr/share/applications/transmute.desktop"
ICON_PATH="/usr/share/icons/hicolor/256x256/apps/transmute.png"

# 2. Prerequisites
echo -e "\n${YELLOW}Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
    echo -e "${RED}✗ Node.js not found. Please install it first.${NC}"
    exit 1
fi

if ! command -v npm &>/dev/null; then
    echo -e "${RED}✗ npm not found. Please install it first.${NC}"
    exit 1
fi

# 3. Preparation
echo -e "${YELLOW}Installing/checking dependencies in source...${NC}"
cd "$SRC_DIR"
npm install --production

# 4. Installation (Requires sudo)
echo -e "\n${YELLOW}Installing to system (requires sudo)...${NC}"

# Create directory
sudo mkdir -p "$INSTALL_DIR"

# Copy files (excluding git and local node_modules to ensure a clean production install)
echo -e "${YELLOW}Copying files to $INSTALL_DIR...${NC}"
sudo rsync -av --progress --exclude '.git' --exclude 'node_modules' . "$INSTALL_DIR/"

# Install dependencies in-place
echo -e "${YELLOW}Installing production dependencies in $INSTALL_DIR...${NC}"
cd "$INSTALL_DIR"
# Force electron download if it's in dependencies
sudo npm install --production --unsafe-perm

# Ensure electron binary is executable
if [ -f "$INSTALL_DIR/node_modules/.bin/electron" ]; then
    sudo chmod +x "$INSTALL_DIR/node_modules/.bin/electron"
fi

# 5. Create Wrapper Script
echo -e "${YELLOW}Creating binary wrapper...${NC}"
cat <<EOF | sudo tee "$BIN_PATH" > /dev/null
#!/usr/bin/env bash
# Wrapper for Transmute
export ELECTRON_DISABLE_SECURITY_WARNINGS=true
export NODE_ENV=production
cd "$INSTALL_DIR"

# Use local electron if available, fallback to system electron
if [ -f "./node_modules/.bin/electron" ]; then
    ./node_modules/.bin/electron . --no-sandbox "\$@"
else
    npm start -- --no-sandbox "\$@"
fi
EOF
sudo chmod +x "$BIN_PATH"

# 6. Desktop Entry
echo -e "${YELLOW}Creating desktop menu entry...${NC}"
cat <<EOF | sudo tee "$DESKTOP_PATH" > /dev/null
[Desktop Entry]
Name=Transmute
Exec=$BIN_PATH
Icon=transmute
Type=Application
Categories=System;Utility;
Comment=Non-destructive filesystem converter
Terminal=false
StartupWMClass=transmute
Keywords=filesystem;disk;convert;ntfs;ext4;
EOF

# 7. Icon Setup
sudo mkdir -p "/usr/share/icons/hicolor/256x256/apps/"
if [ -f "$SRC_DIR/src/assets/icon.png" ]; then
    sudo cp "$SRC_DIR/src/assets/icon.png" "$ICON_PATH"
fi
# Also copy to a generic location as backup
sudo mkdir -p "/usr/share/icons/hicolor/scalable/apps/"
sudo cp "$SRC_DIR/src/assets/icon.png" "/usr/share/icons/hicolor/scalable/apps/transmute.png" || true

# Update databases
sudo update-desktop-database /usr/share/applications || true
sudo gtk-update-icon-cache /usr/share/icons/hicolor || true

echo -e "\n${GREEN}✓ Transmute has been installed successfully!${NC}"
echo -e "You can now find Transmute in your application menu or run '${BLUE}transmute${NC}' from terminal."
echo -e "\n${YELLOW}Note:${NC} Disk operations will prompt for password via pkexec/sudo when needed."
