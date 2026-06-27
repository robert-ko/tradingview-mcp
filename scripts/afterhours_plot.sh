#!/usr/bin/env bash
# After-market trade-plotter cron entry point.
# Generates today's trade indicators and uploads them to the matching chart panes.
# Designed to be run from cron (minimal env) — sets PATH and logs with rotation.
#
# Crontab (16:00 CDT, weekdays):
#   0 16 * * 1-5 /mnt/c/Users/Robert/Dropbox/Projects/tradingview-mcp/scripts/afterhours_plot.sh
#
# Requires: WSL running at run time, TradingView Desktop open with CDP (port 9222).

set -uo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
MCP_DIR="/mnt/c/Users/Robert/Dropbox/Projects/tradingview-mcp"
NODE="/usr/bin/node"
LOG_DIR="$MCP_DIR/logs"
LOG="$LOG_DIR/afterhours_plot.log"

mkdir -p "$LOG_DIR"

# Keep the log from growing forever (trim to last 2000 lines).
if [[ -f "$LOG" ]] && [[ "$(wc -l < "$LOG")" -gt 2000 ]]; then
  tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

{
  echo "=================================================================="
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] afterhours_plot starting"
  cd "$MCP_DIR" || { echo "cannot cd to $MCP_DIR"; exit 1; }
  "$NODE" "$MCP_DIR/scripts/plot_today_trades.mjs"
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] afterhours_plot exited $?"
} >> "$LOG" 2>&1
