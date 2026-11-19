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
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-512}"
var_disk="${var_disk:-2}"
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

  if check_for_gh_release "proxmox-crt" "dubsector/proxmox-crt"; then
    # Swapped in while the bridge runs: the old files are removed only once the
    # new release has unpacked, so a failed download leaves it as it was.
    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "proxmox-crt" "dubsector/proxmox-crt" "prebuild" "latest" "/opt/proxmox-crt" "proxmox-crt-linux-$(dpkg --print-architecture).tar.gz"

    msg_info "Restarting Service"
    install -m 644 /opt/proxmox-crt/proxmox-crt.service /etc/systemd/system/proxmox-crt.service
    systemctl daemon-reload
    systemctl restart proxmox-crt
    msg_ok "Restarted Service"

    # Containers made before the releases built the bridge in place. Clear out
    # whatever a build that did not finish left behind.
    if [[ -d /opt/proxmox-crt-src || -d "$HOME/.cargo" || -d "$HOME/.rustup" ]]; then
      msg_info "Removing Old Build Tools"
      remove_old_tool_version "rust" 2>/dev/null || true
      remove_old_tool_version "nodejs" "nodesource" 2>/dev/null || true
      if dpkg -s build-essential >/dev/null 2>&1; then
        $STD apt purge -y build-essential
      fi
      $STD apt -y autoremove
      rm -rf /opt/proxmox-crt-src ~/.npm /var/cache/app-versions/rust_version.txt /var/cache/app-versions/nodejs_version.txt
      msg_ok "Removed Old Build Tools"
    fi
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
