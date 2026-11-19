#!/usr/bin/env bash
_CS_DEFAULT_URL="https://raw.githubusercontent.com/dubsector/proxmox-crt/main"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")

# Copyright (c) 2021-2026 community-scripts ORG
# Author: dubsector
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/dubsector/proxmox-crt

APP="Proxmox-CRT"
var_tags="${var_tags:-proxmox;dashboard}"
var_cpu="${var_cpu:-2}"
# RAM is sized for the Rust release build; the running bridge needs far less.
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
#var_arm64="${var_arm64:-no}" # unset = ask the user; set yes/no only when verified
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info

  if [[ ! -f /opt/proxmox-crt/proxmox-crt ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  # The container's `update` command remembers where the scripts were when it
  # was made. One made while they were looked for elsewhere finds nothing
  # there, so have it look where this run came from. Before the
  # checks below, any of which can end the run.
  if declare -f write_update_entrypoint >/dev/null; then
    write_update_entrypoint "${NSAPP:-proxmox-crt}" "proxmox-crt" "${COMMUNITY_SCRIPTS_URL:-$_CS_DEFAULT_URL}" 2>/dev/null || msg_warn "Could not point the update command at ${COMMUNITY_SCRIPTS_URL:-$_CS_DEFAULT_URL}"
  fi

  check_container_storage
  check_container_resources

  if check_for_gh_branch "proxmox-crt" "dubsector/proxmox-crt"; then
    ensure_dependencies build-essential
    NODE_VERSION="22" setup_nodejs
    RUST_PROFILE="minimal" setup_rust
    # The fetch records the new commit straight away. Put the old one back until
    # the new build is running, so that a failed build is tried again next time.
    OLD_COMMIT="$(cat /root/.proxmox-crt 2>/dev/null || true)"
    CLEAN_INSTALL=1 fetch_and_deploy_gh_branch "proxmox-crt" "dubsector/proxmox-crt" "" "/opt/proxmox-crt-src"
    NEW_COMMIT="$(cat /root/.proxmox-crt)"
    echo "$OLD_COMMIT" >/root/.proxmox-crt

    msg_info "Building Proxmox-CRT"
    cd /opt/proxmox-crt-src
    $STD npm ci
    $STD npm run build
    cd /opt/proxmox-crt-src/server
    CARGO_BUILD_JOBS="$(get_parallel_jobs)" $STD cargo build --release --locked
    msg_ok "Built Proxmox-CRT"

    msg_info "Stopping Service"
    systemctl stop proxmox-crt
    msg_ok "Stopped Service"

    msg_info "Updating Proxmox-CRT"
    install -m 755 /opt/proxmox-crt-src/server/target/release/proxmox-crt /opt/proxmox-crt/proxmox-crt
    rm -rf /opt/proxmox-crt/client
    cp -r /opt/proxmox-crt-src/dist /opt/proxmox-crt/client
    install -m 644 /opt/proxmox-crt-src/deploy/proxmox-crt.service /etc/systemd/system/proxmox-crt.service
    systemctl daemon-reload
    msg_ok "Updated Proxmox-CRT"

    msg_info "Starting Service"
    systemctl start proxmox-crt
    echo "$NEW_COMMIT" >/root/.proxmox-crt
    msg_ok "Started Service"

    cd ~
    remove_old_tool_version "rust"
    msg_info "Removing Build Tools"
    remove_old_tool_version "nodejs" "nodesource"
    $STD apt purge -y build-essential
    $STD apt -y autoremove
    # Drop the version records too, or the engine puts the tools back by itself.
    rm -rf /opt/proxmox-crt-src ~/.npm /var/cache/app-versions/rust_version.txt /var/cache/app-versions/nodejs_version.txt
    msg_ok "Removed Build Tools"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:8086${CL}"
echo -e "${INFO}${YW}The page asks for a setup code. Read it in the container: journalctl -u proxmox-crt${CL}"
