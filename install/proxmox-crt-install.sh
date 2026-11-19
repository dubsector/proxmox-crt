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

fetch_and_deploy_gh_release "proxmox-crt" "dubsector/proxmox-crt" "prebuild" "latest" "/opt/proxmox-crt" "proxmox-crt-linux-$(dpkg --print-architecture).tar.gz"

msg_info "Installing Proxmox-CRT"
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin proxmox-crt
install -d -m 750 -o proxmox-crt -g proxmox-crt /etc/proxmox-crt
msg_ok "Installed Proxmox-CRT"

msg_info "Creating Service"
install -m 644 /opt/proxmox-crt/proxmox-crt.service /etc/systemd/system/proxmox-crt.service
systemctl enable -q --now proxmox-crt
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
