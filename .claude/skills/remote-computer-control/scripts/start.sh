#!/bin/bash

set -e
export PATH="/home/caifeng.nice/.gvm/gos/go1.19/bin:$PATH"
SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)
echo "SCRIPT_DIR: $SCRIPT_DIR"
cd "$SCRIPT_DIR"

go mod tidy