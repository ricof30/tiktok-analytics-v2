#!/bin/bash
set -e

echo "Installing dependencies..."
npm install

echo "Installing Puppeteer Chrome..."
npx puppeteer browsers install chrome

echo "Build complete!"
