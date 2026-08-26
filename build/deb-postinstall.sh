#!/bin/bash
# Custom Debian post-install (replaces electron-builder's default postinst).
#
# Why this exists: the default script only makes chrome-sandbox SUID (mode 4755)
# when it can't create a user namespace *at install time*. On Ubuntu 24.04+/26.04
# `unshare --user` succeeds here, so it picks mode 0755 and trusts the
# user-namespace sandbox — but AppArmor then blocks the *Electron binary* from
# creating that namespace at runtime, so Chromium falls back to the SUID sandbox,
# finds it isn't 4755, and aborts ("The SUID sandbox helper binary ... is not
# configured correctly"). Forcing 4755 makes the secure SUID sandbox work on
# every system, which is the safe, universal choice.

set -e

# Keep the /usr/bin launcher symlink (same as the default script).
if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/customs-compliance' -a -e '/usr/bin/customs-compliance' -a "$(readlink '/usr/bin/customs-compliance')" != '/etc/alternatives/customs-compliance' ]; then
        rm -f '/usr/bin/customs-compliance'
    fi
    update-alternatives --install '/usr/bin/customs-compliance' 'customs-compliance' '/opt/Customs Compliance/customs-compliance' 100 || ln -sf '/opt/Customs Compliance/customs-compliance' '/usr/bin/customs-compliance'
else
    ln -sf '/opt/Customs Compliance/customs-compliance' '/usr/bin/customs-compliance'
fi

# Always give chrome-sandbox the SUID bit so the sandbox works everywhere.
chmod 4755 '/opt/Customs Compliance/chrome-sandbox' || true
chown root:root '/opt/Customs Compliance/chrome-sandbox' || true

# Refresh the desktop/mime caches so the menu entry appears (same as default).
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
