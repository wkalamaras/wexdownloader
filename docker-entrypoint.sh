#!/bin/sh
set -e

# Ensure the persistent directory exists and has proper permissions
if [ ! -d "$PERSISTENT_DIR" ]; then
    mkdir -p "$PERSISTENT_DIR"
fi

# Try to set permissions if we have access
chmod -R 755 "$PERSISTENT_DIR" 2>/dev/null || true

echo "✓ Persistent directory ready: $PERSISTENT_DIR"
echo "  User: $(whoami)"
echo "  Permissions: $(ls -ld $PERSISTENT_DIR)"

# Start the application
exec node pdf-webhook-server.js