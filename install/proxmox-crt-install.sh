#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: dubsector
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/dubsector/proxmox-crt

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

msg_info "Installing Dependencies"
$STD apt install -y build-essential
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs
RUST_PROFILE="minimal" setup_rust
fetch_and_deploy_gh_branch "proxmox-crt" "dubsector/proxmox-crt" "" "/opt/proxmox-crt-src"

msg_info "Building Proxmox-CRT"
cd /opt/proxmox-crt-src
$STD npm ci
$STD npm run build
cd /opt/proxmox-crt-src/server
CARGO_BUILD_JOBS="$(get_parallel_jobs)" $STD cargo build --release --locked
msg_ok "Built Proxmox-CRT"

msg_info "Installing Proxmox-CRT"
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin proxmox-crt
mkdir -p /opt/proxmox-crt
install -m 755 /opt/proxmox-crt-src/server/target/release/proxmox-crt /opt/proxmox-crt/proxmox-crt
cp -r /opt/proxmox-crt-src/dist /opt/proxmox-crt/client
install -d -m 750 -o proxmox-crt -g proxmox-crt /etc/proxmox-crt
msg_ok "Installed Proxmox-CRT"

msg_info "Creating Service"
install -m 644 /opt/proxmox-crt-src/deploy/proxmox-crt.service /etc/systemd/system/proxmox-crt.service
systemctl enable -q --now proxmox-crt
msg_ok "Created Service"

cd ~
remove_old_tool_version "rust"
msg_info "Removing Build Tools"
remove_old_tool_version "nodejs" "nodesource"
$STD apt purge -y build-essential
# Drop the version records too, or the engine puts the tools back by itself.
rm -rf /opt/proxmox-crt-src ~/.npm /var/cache/app-versions/rust_version.txt /var/cache/app-versions/nodejs_version.txt
msg_ok "Removed Build Tools"

motd_ssh
customize
cleanup_lxc
